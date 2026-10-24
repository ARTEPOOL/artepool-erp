/**
 * Migration 0014: the cash core. A register sells on the POS series; one open shift per register
 * and per cashier; only the shift's own cashier works on it (decision 0004); a closed shift never
 * changes; a recount needs an approval and there is at most one (0006); a count equals its lines.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDevice,
  createTestDatabase,
  createUser,
  setContext,
  type TestDatabase,
} from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;
let owner: bigint;
let cashierA: bigint;
let cashierB: bigint;
let supervisor: bigint;
let device: bigint;
let refs: { branch: string; warehouse: string; pos: string; inv: string; rct: string };

const rule = (hint: string) => ({ code: 'AP011', hint });
const denied = (hint: string) => ({ code: 'AP012', hint });

async function tx<T>(work: (c: pg.Client) => Promise<T>, userId: bigint): Promise<T> {
  await api.query('BEGIN');
  try {
    await setContext(api, userId, null, device);
    const result = await work(api);
    await api.query('COMMIT');
    return result;
  } catch (error) {
    await api.query('ROLLBACK');
    throw error;
  }
}

const one = async <T extends pg.QueryResultRow>(
  c: pg.Client,
  sql: string,
  params: unknown[] = [],
) => (await c.query<T>(sql, params)).rows[0]!;

const register = (code: string, series = refs.pos) =>
  tx(
    (c) =>
      one<{ id: string }>(
        c,
        `INSERT INTO cash.registers (code, name_ar, name_en, branch_id, warehouse_id, invoice_series_id,
                                     receipt_series_id, drop_threshold_fils)
         VALUES ($1, 'درج', 'Drawer', $2, $3, $4, $5, 200000) RETURNING id`,
        [code, refs.branch, refs.warehouse, series, refs.rct],
      ),
    owner,
  );

const openShift = (registerId: string, cashier: bigint) =>
  tx(
    (c) =>
      one<{ id: string; shift_number: string; cashier_id: string }>(
        c,
        `INSERT INTO cash.shifts (register_id, opening_float_fils) VALUES ($1, 0)
         RETURNING id, shift_number, cashier_id::text`,
        [registerId],
      ),
    cashier,
  );

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  owner = await createUser(api, {
    username: 'owner.cash',
    roles: ['owner'],
    signInMethod: 'password_totp',
  });
  cashierA = await createUser(api, { username: 'cashier.a', roles: ['cashier'] });
  cashierB = await createUser(api, { username: 'cashier.b', roles: ['cashier'] });
  supervisor = await createUser(api, {
    username: 'super.cash',
    roles: ['accountant'],
    withPin: true,
  });
  device = await createDevice(api, { code: 'POS-CASH' });
  const r = await one<typeof refs>(
    api,
    `SELECT (SELECT id::text FROM sys.branches ORDER BY id LIMIT 1) AS branch,
            (SELECT id::text FROM md.warehouses WHERE code = 'MAIN') AS warehouse,
            (SELECT id::text FROM sys.document_series WHERE doc_type = 'invoice' AND channel = 'pos') AS pos,
            (SELECT id::text FROM sys.document_series WHERE doc_type = 'invoice' AND channel = 'office') AS inv,
            (SELECT id::text FROM sys.document_series WHERE doc_type = 'receipt') AS rct`,
  );
  refs = r;
});
afterAll(() => db.drop());

describe('registers and shifts (decision 0004)', () => {
  it('a register sells on the POS series only', async () => {
    await expect(register('DRAWER-X', refs.inv)).rejects.toMatchObject(rule('SERIES_MISMATCH'));
    expect((await register('DRAWER-1')).id).toBeTruthy();
  });

  it('one open shift per register and per cashier; the opener is the cashier; numbered Z-', async () => {
    const r1 = await register('DRAWER-2');
    const r2 = await register('DRAWER-3');
    const shift = await openShift(r1.id, cashierA);
    expect(shift.shift_number).toMatch(/^Z-/);
    expect(shift.cashier_id).toBe(cashierA.toString());
    // Another cashier cannot open a second shift on the same drawer.
    await expect(openShift(r1.id, cashierB)).rejects.toMatchObject({ code: '23505' });
    // The same cashier cannot hold two open shifts.
    await expect(openShift(r2.id, cashierA)).rejects.toMatchObject({ code: '23505' });
  });

  it('only the shift’s own cashier works on it', async () => {
    const r = await register('DRAWER-4');
    const shift = await openShift(r.id, cashierB);
    await expect(
      tx((c) => c.query(`SELECT cash.assert_shift_owner($1)`, [shift.id]), cashierA),
    ).rejects.toMatchObject(denied('SHIFT_NOT_OWNER'));
    expect(
      (
        await tx(
          (c) => one<{ r: string }>(c, `SELECT cash.assert_shift_owner($1)::text AS r`, [shift.id]),
          cashierB,
        )
      ).r,
    ).toBe(r.id);
  });
});

describe('counts (decision 0006)', () => {
  it('a count equals its lines; a recount needs an approval; at most one of each; closed shifts are final', async () => {
    const r = await register('DRAWER-5');
    const cashier = await createUser(api, { username: 'cashier.c', roles: ['cashier'] });
    const shift = await openShift(r.id, cashier);
    const note100 = (
      await one<{ id: string }>(
        api,
        `SELECT id::text FROM md.cash_denominations WHERE value_fils = 10000`,
      )
    ).id;
    const count = (
      total: number,
      supersedes: string | null = null,
      approval: string | null = null,
    ) =>
      tx(async (c) => {
        const row = await one<{ id: string }>(
          c,
          `INSERT INTO cash.counts (shift_id, purpose, total_fils, supersedes_id, approval_id)
           VALUES ($1, 'closing', $2, $3, $4) RETURNING id::text`,
          [shift.id, total, supersedes, approval],
        );
        await c.query(
          `INSERT INTO cash.count_lines (count_id, denomination_id, quantity) VALUES ($1, $2, 3)`,
          [row.id, note100],
        );
        return row;
      }, cashier);

    await expect(count(99999)).rejects.toMatchObject(rule('COUNT_TOTAL')); // 3 × 100.00 = 300.00
    const first = await count(30000);
    await expect(count(30000, first.id)).rejects.toMatchObject(denied('APPROVAL_INVALID')); // no approval
    const approval = await tx(
      async (c) =>
        (
          await one<{ id: string }>(
            c,
            `INSERT INTO auth.approvals (permission_code, approved_by, reason_text)
             VALUES ('shifts.recount', $1, 'Recount the drawer') RETURNING id::text`,
            [supervisor],
          )
        ).id,
      cashier,
    );
    const recount = await count(30000, first.id, approval);
    await expect(count(30000, first.id, approval)).rejects.toBeTruthy(); // only one recount

    // (Migration 0022: the counted cash goes to the safe with the close, and has its journal entry.)
    await tx(async (c) => {
      const m = await one<{ id: string }>(
        c,
        `INSERT INTO cash.movements (shift_id, movement_type, amount_fils)
         VALUES ($1, 'closing_transfer', 30000) RETURNING id::text`,
        [shift.id],
      );
      const e = await one<{ id: string }>(
        c,
        `INSERT INTO gl.journal_entries (entry_date, source_type, cash_movement_id, total_debit_fils, total_credit_fils)
         VALUES (sys.business_date(), 'cash_movement', $1, 30000, 30000) RETURNING id::text`,
        [m.id],
      );
      await c.query(
        `INSERT INTO gl.journal_lines (entry_id, line_no, account_id, debit_fils, credit_fils)
         SELECT $1::bigint, 1, id, 30000, 0 FROM gl.accounts WHERE code = '1120'
         UNION ALL SELECT $1::bigint, 2, id, 0, 30000 FROM gl.accounts WHERE code = '1110'`,
        [e.id],
      );
      await c.query(
        `UPDATE cash.shifts SET status = 'closed', closing_count_id = $2, expected_cash_fils = 30000,
                counted_cash_fils = 30000, variance_fils = 0, z_snapshot = '{}' WHERE id = $1`,
        [shift.id, recount.id],
      );
    }, cashier);
    await expect(
      tx(
        (c) => c.query(`UPDATE cash.shifts SET variance_note = 'later' WHERE id = $1`, [shift.id]),
        cashier,
      ),
    ).rejects.toMatchObject({ code: 'AP003' });
    await expect(
      tx(
        (c) => c.query(`UPDATE cash.shifts SET status = 'open' WHERE id = $1`, [shift.id]),
        cashier,
      ),
    ).rejects.toBeTruthy();
    await expect(
      tx((c) => c.query(`DELETE FROM cash.counts WHERE id = $1`, [first.id]), owner),
    ).rejects.toBeTruthy();
  });
});
