/**
 * Migration 0022: cash events. Only the open shift's own cashier moves its cash (decision 0004);
 * a paid-out needs approval; money never leaves a drawer beyond what it holds; the opening float
 * and the closing transfer post with the shift; the close takes expected, counted and variance
 * from the database (float + cash sales ± movements); a closed shift and its movements never
 * change; the variance is accepted once, by the owner or the accountant (0058); counts take the
 * 0.10 / 0.05 coins and an "other amount" (0056); a No Sale needs a reason.
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
let accountant: bigint;
let device: bigint;
let today: string;
let codeNo = 0;
const r: Record<string, string> = {};

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

/** A balanced two-line journal entry for a source. */
async function journal(
  c: pg.Client,
  source: 'cash_movement' | 'shift_close' | 'sales_document' | 'payment',
  id: string,
  amount: number,
  debit: string,
  credit: string,
  customerId: string | null = null,
) {
  const column = {
    cash_movement: 'cash_movement_id',
    shift_close: 'shift_id',
    sales_document: 'sales_document_id',
    payment: 'payment_id',
  }[source];
  const e = await one<{ id: string }>(
    c,
    `INSERT INTO gl.journal_entries (entry_date, source_type, ${column}, total_debit_fils, total_credit_fils)
     VALUES ($1, $2, $3, $4, $4) RETURNING id`,
    [today, source, id, amount],
  );
  await c.query(
    `INSERT INTO gl.journal_lines (entry_id, line_no, account_id, debit_fils, credit_fils, customer_id)
     VALUES ($1, 1, $2, $4, 0, $5), ($1, 2, $3, 0, $4, $5)`,
    [e.id, debit, credit, amount, customerId],
  );
}

interface MovementIn {
  type: string;
  amount: number;
  reason?: string | null;
  approval?: string | null;
}

/** A cash movement and its journal entry (posting map rows 16–18). */
async function move(c: pg.Client, shift: string, m: MovementIn) {
  const row = await one<{ id: string; voucher_number: string; direction: string }>(
    c,
    `INSERT INTO cash.movements (shift_id, movement_type, amount_fils, reason_code_id, approval_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, voucher_number, direction`,
    [shift, m.type, m.amount, m.reason ?? null, m.approval ?? null],
  );
  const [debit, credit] = row.direction === 'in' ? [r.drawer, r.safe] : [r.safe, r.drawer];
  await journal(c, 'cash_movement', row.id, m.amount, debit!, credit!);
  return row;
}

async function register() {
  codeNo += 1;
  return tx(
    async (c) =>
      (
        await one<{ id: string }>(
          c,
          `INSERT INTO cash.registers (code, name_ar, name_en, branch_id, warehouse_id, invoice_series_id,
                                       receipt_series_id, drop_threshold_fils)
           VALUES ($1, 'درج', 'Drawer', $2, $3, $4, $5, 300000) RETURNING id`,
          [`EV-${codeNo}`, r.branch, r.warehouse, r.pos, r.rct],
        )
      ).id,
    owner,
  );
}

/** Opens a shift with its float, the float moving from the safe in the same transaction. */
const openShift = (registerId: string, cashier: bigint, float = 50_000) =>
  tx(async (c) => {
    const s = await one<{ id: string }>(
      c,
      `INSERT INTO cash.shifts (register_id, opening_float_fils) VALUES ($1, $2) RETURNING id`,
      [registerId, float],
    );
    if (float > 0) await move(c, s.id, { type: 'opening_float', amount: float });
    return s.id;
  }, cashier);

const approval = (permission: string, requester: bigint) =>
  tx(
    async (c) =>
      (
        await one<{ id: string }>(
          c,
          `INSERT INTO auth.approvals (permission_code, approved_by, reason_text)
           VALUES ($1, $2, 'Supervisor approves') RETURNING id`,
          [permission, accountant],
        )
      ).id,
    requester,
  );

/** A closing count: so many 100-dirham notes, plus an other amount. */
const count = async (
  c: pg.Client,
  shift: string,
  notes: number,
  other = 0,
  supersedes: string | null = null,
  approvalId: string | null = null,
) => {
  const row = await one<{ id: string }>(
    c,
    `INSERT INTO cash.counts (shift_id, purpose, total_fils, other_amount_fils, supersedes_id, approval_id)
     VALUES ($1, 'closing', $2, $3, $4, $5) RETURNING id`,
    [shift, notes * 10_000 + other, other, supersedes, approvalId],
  );
  if (notes > 0)
    await c.query(
      `INSERT INTO cash.count_lines (count_id, denomination_id, quantity) VALUES ($1, $2, $3)`,
      [row.id, r.note100, notes],
    );
  return row.id;
};

/** Closes the shift: the counted cash goes to the safe; the database works out the rest. */
const close = (shift: string, cashier: bigint, counted: number) =>
  tx(async (c) => {
    if (counted > 0) await move(c, shift, { type: 'closing_transfer', amount: counted });
    return one<{ expected_cash_fils: string; counted_cash_fils: string; variance_fils: string }>(
      c,
      `UPDATE cash.shifts SET status = 'closed', z_snapshot = '{}', expected_cash_fils = 1,
              counted_cash_fils = 1, variance_fils = 0
        WHERE id = $1
       RETURNING expected_cash_fils::text, counted_cash_fils::text, variance_fils::text`,
      [shift],
    );
  }, cashier);

/** A POS cash sale of a service on the shift: invoice, payment, allocation, journals. */
async function cashSale(shift: string, cashier: bigint, gross: number) {
  return tx(async (c) => {
    const doc = await one<{ id: string }>(
      c,
      `INSERT INTO sales.documents (doc_type, channel, branch_id, business_line_id, warehouse_id, device_id,
                                    customer_id, bill_to_name, shift_id)
       VALUES ('invoice', 'pos', $1, $2, $3, $4, $5, 'Cash customer', $6) RETURNING id`,
      [r.branch, r.line, r.warehouse, device, r.walkIn, shift],
    );
    await c.query(
      `INSERT INTO sales.document_lines (document_id, line_no, item_id, description_ar, description_en,
                                         business_line_id, quantity, unit_price_4dp, vat_category_id,
                                         net_fils, vat_fils, gross_fils)
       VALUES ($1, 1, $2, 'خدمة', 'Service', $3, 1, $4, $5, 0, 0, 0)`,
      [doc.id, r.service, r.line, gross * 100, r.vat],
    );
    await c.query(
      `UPDATE sales.documents SET status = 'issued', content_hash = '\\x01' WHERE id = $1`,
      [doc.id],
    );
    await journal(c, 'sales_document', doc.id, gross, r.ar!, r.vatOut!, r.walkIn);
    const p = await one<{ id: string }>(
      c,
      `INSERT INTO sales.payments (payment_kind, customer_id, payment_method_id, amount_fils, tendered_fils,
                                   change_fils, payment_date, channel, device_id, shift_id)
       VALUES ('receipt', $1, $2, $3, $4, $5, $6, 'pos', $7, $8) RETURNING id`,
      [r.walkIn, r.cash, gross, gross + 500, 500, today, device, shift],
    );
    await c.query(
      `INSERT INTO sales.payment_allocations (payment_id, document_id, amount_fils) VALUES ($1, $2, $3)`,
      [p.id, doc.id, gross],
    );
    await journal(c, 'payment', p.id, gross, r.drawer!, r.ar!, r.walkIn);
  }, cashier);
}

const expected = async (shift: string) =>
  Number((await one<{ e: string }>(api, `SELECT cash.expected_cash($1)::text AS e`, [shift])).e);

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  owner = await createUser(api, {
    username: 'owner.events',
    roles: ['owner'],
    signInMethod: 'password_totp',
  });
  accountant = await createUser(api, {
    username: 'acc.events',
    roles: ['accountant'],
    withPin: true,
  });
  device = await createDevice(api, { code: 'POS-EVENTS' });
  today = (await one<{ d: string }>(api, `SELECT sys.business_date()::text AS d`)).d;
  Object.assign(
    r,
    await one<Record<string, string>>(
      api,
      `SELECT (SELECT id::text FROM sys.branches ORDER BY id LIMIT 1) AS branch,
              (SELECT id::text FROM md.business_lines ORDER BY id LIMIT 1) AS line,
              (SELECT id::text FROM md.warehouses WHERE code = 'MAIN') AS warehouse,
              (SELECT id::text FROM sys.document_series WHERE doc_type = 'invoice' AND channel = 'pos') AS pos,
              (SELECT id::text FROM sys.document_series WHERE doc_type = 'receipt') AS rct,
              (SELECT id::text FROM md.vat_categories WHERE code = 'SR') AS vat,
              (SELECT id::text FROM md.price_levels WHERE is_default) AS level,
              (SELECT id::text FROM md.item_categories WHERE code = 'EQUIP') AS category,
              (SELECT id::text FROM md.payment_methods WHERE kind = 'cash' ORDER BY id LIMIT 1) AS cash,
              (SELECT id::text FROM md.cash_denominations WHERE value_fils = 10000) AS note100,
              (SELECT id::text FROM gl.accounts WHERE code = '1110') AS drawer,
              (SELECT id::text FROM gl.accounts WHERE code = '1120') AS safe,
              (SELECT id::text FROM gl.accounts WHERE code = '6910') AS "overShort",
              (SELECT account_id::text FROM gl.account_mappings WHERE key = 'ar_control') AS ar,
              (SELECT account_id::text FROM gl.account_mappings WHERE key = 'vat_output') AS "vatOut",
              (SELECT id::text FROM sys.reason_codes WHERE category = 'paid_out' AND code = 'PETTY') AS petty,
              (SELECT id::text FROM sys.reason_codes WHERE category = 'paid_in' AND code = 'CHANGE_FLOAT') AS "changeFloat",
              (SELECT id::text FROM sys.reason_codes WHERE category = 'no_sale' AND code = 'GIVE_CHANGE') AS "giveChange"`,
    ),
  );
  await tx(async (c) => {
    await c.query(
      `INSERT INTO sys.company_profile (id, legal_name_ar, legal_name_en, address_ar, address_en, vat_registered, trn)
       VALUES (1, 'آرتيبول', 'ARTEPOOL', 'العين', 'Al Ain', true, '100000000000003')`,
    );
    r.walkIn = (
      await one<{ id: string }>(
        c,
        `INSERT INTO md.customers (code, customer_type, name, phone) VALUES ('WALKIN', 'individual', 'Cash customer', '+971500000001')
         RETURNING id::text`,
      )
    ).id;
    r.service = (
      await one<{ id: string }>(
        c,
        `INSERT INTO md.items (code, item_type, name_ar, name_en, category_id, unit_id, vat_category_id)
         VALUES ('SVC-EV', 'service', 'خدمة', 'Service', $1, (SELECT id FROM md.units WHERE code = 'VISIT'), $2)
         RETURNING id::text`,
        [r.category, r.vat],
      )
    ).id;
    await c.query(
      `INSERT INTO md.item_prices (price_level_id, item_id, price_4dp, includes_vat) VALUES ($1, $2, 1000000, true)`,
      [r.level, r.service],
    );
  }, owner);
});
afterAll(() => db.drop());

describe('seeds and settings (decisions 0056–0059)', () => {
  it('has the 0.10 and 0.05 coins, the alert settings and the cashier’s 5% limit', async () => {
    const coins = await api.query<{ v: string }>(
      `SELECT value_fils::text AS v FROM md.cash_denominations WHERE value_fils IN (10, 5) AND kind = 'coin' ORDER BY 1`,
    );
    expect(coins.rows.map((x) => x.v)).toEqual(['10', '5']);
    const settings = await api.query<{ key: string; v: string }>(
      `SELECT key, sys.setting_bigint(key)::text AS v FROM sys.settings
        WHERE key IN ('cash.drop_alert_fils', 'cash.variance_alert_fils', 'cash.variance_alert_days',
                      'cash.variance_alert_repeat_count') ORDER BY key`,
    );
    expect(Object.fromEntries(settings.rows.map((s) => [s.key, s.v]))).toEqual({
      'cash.drop_alert_fils': '300000',
      'cash.variance_alert_days': '30',
      'cash.variance_alert_fils': '2000',
      'cash.variance_alert_repeat_count': '3',
    });
    const role = await one<{ bp: number }>(
      api,
      `SELECT max_discount_bp AS bp FROM auth.roles WHERE code = 'cashier'`,
    );
    expect(role.bp).toBe(500);
  });
});

describe('movements (decision 0004, posting map rows 16–18)', () => {
  it('the float must come from the safe; movements are numbered CV- and need their journal entry', async () => {
    const cashier = await createUser(api, { username: 'ev.float', roles: ['cashier'] });
    const reg = await register();
    await expect(
      tx(
        (c) =>
          c.query(`INSERT INTO cash.shifts (register_id, opening_float_fils) VALUES ($1, 50000)`, [
            reg,
          ]),
        cashier,
      ),
    ).rejects.toMatchObject(rule('OPENING_FLOAT'));
    const shift = await openShift(reg, cashier);
    await expect(
      tx(
        (c) =>
          c.query(
            `INSERT INTO cash.movements (shift_id, movement_type, amount_fils) VALUES ($1, 'cash_drop', 100)`,
            [shift],
          ),
        cashier,
      ),
    ).rejects.toMatchObject(rule('JOURNAL_MISSING'));
    const drop = await tx((c) => move(c, shift, { type: 'cash_drop', amount: 10_000 }), cashier);
    expect(drop.voucher_number).toMatch(/^CV-/);
    expect(await expected(shift)).toBe(40_000);
  });

  it('only the open shift’s own cashier moves its cash', async () => {
    const a = await createUser(api, { username: 'ev.own.a', roles: ['cashier'] });
    const b = await createUser(api, { username: 'ev.own.b', roles: ['cashier'] });
    const shift = await openShift(await register(), a);
    await expect(
      tx((c) => move(c, shift, { type: 'cash_drop', amount: 100 }), b),
    ).rejects.toMatchObject(denied('SHIFT_NOT_OWNER'));
  });

  it('paid-in and paid-out need a reason of their kind; a paid-out needs approval', async () => {
    const cashier = await createUser(api, { username: 'ev.paid', roles: ['cashier'] });
    const shift = await openShift(await register(), cashier);
    await expect(
      tx((c) => move(c, shift, { type: 'paid_in', amount: 1_000 }), cashier),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      tx(
        (c) => move(c, shift, { type: 'paid_out', amount: 1_000, reason: r.changeFloat }),
        cashier,
      ),
    ).rejects.toMatchObject(rule('REASON_INVALID'));
    await expect(
      tx((c) => move(c, shift, { type: 'paid_out', amount: 1_000, reason: r.petty }), cashier),
    ).rejects.toMatchObject(denied('APPROVAL_REQUIRED'));
    const wrong = await approval('shifts.recount', cashier);
    await expect(
      tx(
        (c) =>
          move(c, shift, { type: 'paid_out', amount: 1_000, reason: r.petty, approval: wrong }),
        cashier,
      ),
    ).rejects.toMatchObject(denied('APPROVAL_REQUIRED'));
    const ok = await approval('cash.paid_out', cashier);
    await tx(
      (c) => move(c, shift, { type: 'paid_out', amount: 1_000, reason: r.petty, approval: ok }),
      cashier,
    );
    await tx(
      (c) => move(c, shift, { type: 'paid_in', amount: 2_500, reason: r.changeFloat }),
      cashier,
    );
    expect(await expected(shift)).toBe(50_000 - 1_000 + 2_500);
  });

  it('money never leaves the drawer beyond what it holds', async () => {
    const cashier = await createUser(api, { username: 'ev.short', roles: ['cashier'] });
    const shift = await openShift(await register(), cashier, 5_000);
    await expect(
      tx((c) => move(c, shift, { type: 'cash_drop', amount: 5_001 }), cashier),
    ).rejects.toMatchObject(rule('DRAWER_SHORT'));
    await tx((c) => move(c, shift, { type: 'cash_drop', amount: 5_000 }), cashier);
  });
});

describe('drawer events', () => {
  it('a No Sale needs a no-sale reason and its permission; every event names its user and PC', async () => {
    const cashier = await createUser(api, { username: 'ev.nosale', roles: ['cashier'] });
    const reg = await register();
    const shift = await openShift(reg, cashier, 0);
    const noSale = (reason: string | null, user: bigint) =>
      tx(
        (c) =>
          one<{ user_id: string; device_id: string }>(
            c,
            `INSERT INTO cash.drawer_events (register_id, shift_id, event_type, reason_code_id)
             VALUES ($1, $2, 'open_no_sale', $3) RETURNING user_id::text, device_id::text`,
            [reg, shift, reason],
          ),
        user,
      );
    await expect(noSale(null, cashier)).rejects.toMatchObject(rule('REASON_INVALID'));
    await expect(noSale(r.petty!, cashier)).rejects.toMatchObject(rule('REASON_INVALID'));
    // The cashier role does not hold pos.no_sale by default.
    await expect(noSale(r.giveChange!, cashier)).rejects.toMatchObject(denied('PERMISSION_DENIED'));
    // Someone holding pos.no_sale (the accountant role) on their own shift may.
    const holder = await createUser(api, { username: 'ev.nosale.ok', roles: ['accountant'] });
    const reg2 = await register();
    const shift2 = await openShift(reg2, holder, 0);
    const ev = await tx(
      (c) =>
        one<{ user_id: string; device_id: string }>(
          c,
          `INSERT INTO cash.drawer_events (register_id, shift_id, event_type, reason_code_id)
           VALUES ($1, $2, 'open_no_sale', $3) RETURNING user_id::text, device_id::text`,
          [reg2, shift2, r.giveChange],
        ),
      holder,
    );
    expect(ev.user_id).toBe(holder.toString());
    expect(ev.device_id).toBe(device.toString());
  });
});

describe('the close (decision 0006)', () => {
  it('expected = float + cash sales ± movements; counted and variance come from the database', async () => {
    const cashier = await createUser(api, { username: 'ev.close', roles: ['cashier'] });
    const shift = await openShift(await register(), cashier, 50_000);
    await cashSale(shift, cashier, 10_000); // 100.00 cash, 5.00 tendered extra and given back
    await tx((c) => move(c, shift, { type: 'cash_drop', amount: 20_000 }), cashier);
    expect(await expected(shift)).toBe(40_000);

    // No count yet: refused.
    await expect(close(shift, cashier, 0)).rejects.toMatchObject(rule('COUNT_MISSING'));
    // Counted 399.95 (3 × 100 notes + 99.95 other): 0.05 short.
    await tx((c) => count(c, shift, 3, 9_995), cashier);
    // The counted cash must go to the safe with the close.
    await expect(
      tx(
        (c) =>
          c.query(
            `UPDATE cash.shifts SET status = 'closed', z_snapshot = '{}', expected_cash_fils = 1,
                    counted_cash_fils = 1, variance_fils = 0 WHERE id = $1`,
            [shift],
          ),
        cashier,
      ),
    ).rejects.toMatchObject(rule('CLOSING_TRANSFER'));
    const closed = await close(shift, cashier, 39_995);
    expect(closed).toEqual({
      expected_cash_fils: '40000',
      counted_cash_fils: '39995',
      variance_fils: '-5',
    });
    // A closed shift takes no more movements and never changes.
    await expect(
      tx((c) => move(c, shift, { type: 'cash_drop', amount: 100 }), cashier),
    ).rejects.toMatchObject(rule('SHIFT_NOT_OPEN'));
    await expect(
      tx((c) => c.query(`DELETE FROM cash.movements WHERE shift_id = $1`, [shift]), owner),
    ).rejects.toBeTruthy();
  });

  it('the recount (with approval) is the count the close uses; both are kept', async () => {
    const cashier = await createUser(api, { username: 'ev.recount', roles: ['cashier'] });
    const shift = await openShift(await register(), cashier, 30_000);
    const first = await tx((c) => count(c, shift, 2), cashier);
    // A recount without a recount approval is refused.
    const wrong = await approval('cash.paid_out', cashier);
    await expect(tx((c) => count(c, shift, 3, 0, first, wrong), cashier)).rejects.toMatchObject(
      denied('APPROVAL_INVALID'),
    );
    const ok = await approval('shifts.recount', cashier);
    await tx((c) => count(c, shift, 3, 0, first, ok), cashier);
    const closed = await close(shift, cashier, 30_000);
    expect(closed.variance_fils).toBe('0');
    const counts = await api.query(`SELECT 1 FROM cash.counts WHERE shift_id = $1`, [shift]);
    expect(counts.rowCount).toBe(2);
  });

  it('a count of only 0.05 coins and an other amount can match exactly', async () => {
    const cashier = await createUser(api, { username: 'ev.fils', roles: ['cashier'] });
    const shift = await openShift(await register(), cashier, 0);
    await tx((c) => move(c, shift, { type: 'float_top_up', amount: 1_237 }), cashier);
    await tx(async (c) => {
      const row = await one<{ id: string }>(
        c,
        `INSERT INTO cash.counts (shift_id, purpose, total_fils, other_amount_fils) VALUES ($1, 'closing', 1237, 2)
         RETURNING id`,
        [shift],
      );
      await c.query(
        `INSERT INTO cash.count_lines (count_id, denomination_id, quantity)
         SELECT $1, id, 247 FROM md.cash_denominations WHERE value_fils = 5`,
        [row.id],
      );
    }, cashier);
    expect((await close(shift, cashier, 1_237)).variance_fils).toBe('0');
  });
});

describe('variance acceptance (decision 0058, posting map row 19)', () => {
  it('owner or accountant only, never the cashier, once per closed shift, with its journal entry', async () => {
    const cashier = await createUser(api, { username: 'ev.accept', roles: ['cashier'] });
    const shift = await openShift(await register(), cashier, 10_000);
    await tx((c) => count(c, shift, 0, 9_000), cashier);
    const accept = (user: bigint, withJournal = true) =>
      tx(async (c) => {
        await c.query(
          `INSERT INTO cash.variance_acceptances (shift_id, note) VALUES ($1, 'Short 10 AED')`,
          [shift],
        );
        if (withJournal) await journal(c, 'shift_close', shift, 1_000, r.overShort!, r.drawer!);
      }, user);

    await expect(accept(accountant)).rejects.toMatchObject(rule('SHIFT_NOT_CLOSED'));
    expect((await close(shift, cashier, 9_000)).variance_fils).toBe('-1000');
    await expect(accept(cashier)).rejects.toMatchObject(denied('PERMISSION_DENIED'));
    await expect(accept(accountant, false)).rejects.toMatchObject(rule('JOURNAL_MISSING'));
    await accept(accountant);
    await expect(accept(owner)).rejects.toMatchObject({ code: '23505' });
    const row = await one<{ variance_fils: string; accepted_by: string }>(
      api,
      `SELECT variance_fils::text, accepted_by::text FROM cash.variance_acceptances WHERE shift_id = $1`,
      [shift],
    );
    expect(row).toEqual({ variance_fils: '-1000', accepted_by: accountant.toString() });
  });
});
