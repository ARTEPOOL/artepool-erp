/**
 * Migration 0012: journal entries. An entry balances or is refused at commit, a document is never
 * posted twice, nothing is dated in a closed month, only active postable accounts are used, a
 * control-account line names its customer, and entries are numbered without gaps and never change.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  createUser,
  inContext,
  setContext,
  type TestDatabase,
} from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;
let admin: pg.Client;
let owner: bigint;
let today: string;
const account: Record<string, string> = {};

const rule = (hint: string) => ({ code: 'AP011', hint });

async function tx<T>(work: (c: pg.Client) => Promise<T>, userId = owner): Promise<T> {
  await api.query('BEGIN');
  try {
    await setContext(api, userId);
    const result = await work(api);
    await api.query('COMMIT');
    return result;
  } catch (error) {
    await api.query('ROLLBACK');
    throw error;
  }
}

interface Line {
  code: string;
  debit?: number;
  credit?: number;
  customer?: string;
}

/** Posts an entry (header, then its lines) and returns its number. */
function post(
  lines: Line[],
  options: {
    date?: string;
    source?: { type: string; column: string; id: string };
    totals?: number;
  } = {},
): Promise<string> {
  const total = options.totals ?? lines.reduce((sum, l) => sum + (l.debit ?? 0), 0);
  return tx(async (c) => {
    const columns = ['entry_date', 'source_type', 'total_debit_fils', 'total_credit_fils'];
    const values: unknown[] = [
      options.date ?? today,
      options.source?.type ?? 'manual',
      total,
      total,
    ];
    if (options.source) {
      columns.push(options.source.column);
      values.push(options.source.id);
    }
    const { rows } = await c.query<{ id: string; entry_number: string }>(
      `INSERT INTO gl.journal_entries (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, entry_number`,
      values,
    );
    for (const [i, l] of lines.entries()) {
      await c.query(
        `INSERT INTO gl.journal_lines (entry_id, line_no, account_id, debit_fils, credit_fils, customer_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rows[0]!.id, i + 1, account[l.code], l.debit ?? 0, l.credit ?? 0, l.customer ?? null],
      );
    }
    return rows[0]!.entry_number;
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  admin = await db.connect('superuser');
  owner = await createUser(api, {
    username: 'owner.gl',
    roles: ['owner'],
    signInMethod: 'password_totp',
  });
  today = (await api.query<{ d: string }>(`SELECT sys.business_date()::text AS d`)).rows[0]!.d;
  const { rows } = await api.query<{ id: string; code: string }>(
    `SELECT id, code FROM gl.accounts`,
  );
  for (const r of rows) account[r.code] = r.id;
});
afterAll(() => db.drop());

describe('journal entries (JV-)', () => {
  it('a balanced entry is posted, numbered without gaps, and stamped', async () => {
    const first = await post([
      { code: '1310', debit: 1235 },
      { code: '3900', credit: 1235 },
    ]);
    const second = await post([
      { code: '5600', debit: 371 },
      { code: '1310', credit: 371 },
    ]);
    expect(first).toMatch(/^JV-/);
    expect(Number(second.replace(/\D/g, ''))).toBe(Number(first.replace(/\D/g, '')) + 1);
    const { rows } = await api.query(
      `SELECT posted_by::text, period_id IS NOT NULL AS has_period FROM gl.journal_entries WHERE entry_number = $1`,
      [first],
    );
    expect(rows[0]).toEqual({ posted_by: owner.toString(), has_period: true });
  });

  it('an entry that does not balance, or has one line, is refused at commit; it uses no number', async () => {
    const before = (await api.query(`SELECT count(*)::int AS n FROM gl.journal_entries`))
      .rows[0] as { n: number };
    await expect(
      post(
        [
          { code: '1310', debit: 100 },
          { code: '3900', credit: 90 },
        ],
        { totals: 100 },
      ),
    ).rejects.toMatchObject(rule('JOURNAL_UNBALANCED'));
    await expect(post([{ code: '1310', debit: 100 }], { totals: 100 })).rejects.toMatchObject(
      rule('JOURNAL_UNBALANCED'),
    );
    // Lines that balance but differ from the header.
    await expect(
      post(
        [
          { code: '1310', debit: 100 },
          { code: '3900', credit: 100 },
        ],
        { totals: 200 },
      ),
    ).rejects.toMatchObject(rule('JOURNAL_UNBALANCED'));
    const after = (await api.query(`SELECT count(*)::int AS n FROM gl.journal_entries`))
      .rows[0] as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('a document is never posted twice', async () => {
    const adjustment = await tx(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO inv.adjustments (kind, warehouse_id, adjustment_date, reason_code_id)
             SELECT 'decrease', w.id, $1, r.id FROM md.warehouses w, sys.reason_codes r
              WHERE w.code = 'MAIN' AND r.category = 'stock_decrease' AND r.code = 'DAMAGED' RETURNING id`,
            [today],
          )
        ).rows[0]!.id,
    );
    const source = {
      type: 'inventory_adjustment',
      column: 'inventory_adjustment_id',
      id: adjustment,
    };
    const lines = [
      { code: '5600', debit: 50 },
      { code: '1310', credit: 50 },
    ];
    await post(lines, { source });
    await expect(post(lines, { source })).rejects.toMatchObject({ code: '23505' });
  });

  it('only active, postable accounts; a customer on control-account lines', async () => {
    await expect(
      post([
        { code: '1300', debit: 10 },
        { code: '3900', credit: 10 },
      ]),
    ).rejects.toMatchObject(rule('POSTING_ACCOUNT_INVALID'));
    await expect(
      post([
        { code: '1210', debit: 10 },
        { code: '3900', credit: 10 },
      ]),
    ).rejects.toMatchObject(rule('POSTING_CUSTOMER_REQUIRED'));
    const customer = (
      await api.query<{ id: string }>(`SELECT id FROM md.customers WHERE is_walk_in`)
    ).rows[0]!.id;
    await post([
      { code: '1210', debit: 10, customer },
      { code: '3900', credit: 10 },
    ]);
  });

  it('nothing is dated in a closed month', async () => {
    // Close January (it has ended): postings dated in it are refused.
    const jan = (
      await api.query<{ id: string; row_version: number }>(
        `SELECT id, row_version FROM gl.periods ORDER BY period_start LIMIT 1`,
      )
    ).rows[0]!;
    await tx((c) => c.query(`UPDATE gl.periods SET status = 'closed' WHERE id = $1`, [jan.id]));
    const date = (
      await api.query<{ d: string }>(
        `SELECT period_start::text AS d FROM gl.periods WHERE id = $1`,
        [jan.id],
      )
    ).rows[0]!.d;
    await expect(
      post(
        [
          { code: '1310', debit: 10 },
          { code: '3900', credit: 10 },
        ],
        { date },
      ),
    ).rejects.toMatchObject(rule('PERIOD_NOT_OPEN'));
  });

  it('entries never change and are never deleted; an account with postings is in use', async () => {
    await expect(api.query(`UPDATE gl.journal_lines SET debit_fils = 1`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      inContext(admin, () => admin.query(`UPDATE gl.journal_entries SET memo = 'x'`)),
    ).rejects.toMatchObject({ code: 'AP003' });
    await expect(admin.query(`DELETE FROM gl.journal_lines`)).rejects.toBeTruthy();
    const use = await api.query<{ u: string }>(`SELECT gl.account_in_use($1) AS u`, [
      account['5600'],
    ]);
    expect(use.rows[0]!.u).toBe('posted');
  });
});
