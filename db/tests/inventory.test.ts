/**
 * Migration 0011: the stock ledger. Stock is never typed over: every in or out is a movement, the
 * balance is derived by the database, stock below zero is refused, the average cost is kept to
 * 4 decimals, the last unit takes exactly the remaining value, and the book amounts never drift
 * from the rounded stock value (decision 0014). Adjustments and counts are numbered when posted
 * and final afterwards (decisions 0003, 0041, 0042, 0044).
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDevice,
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
let accountant: bigint;
let storekeeper: bigint;
let device: bigint;
let warehouse: string;
let today: string;

const rule = (hint: string) => ({ code: 'AP011', hint });
const denied = (hint: string) => ({ code: 'AP012', hint });

/** Runs `work` in one transaction as `userId`, and commits. */
async function tx<T>(
  work: (c: pg.Client) => Promise<T>,
  userId: bigint,
  client: pg.Client = api,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await setContext(client, userId, null, device);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

const one = async <T extends pg.QueryResultRow>(
  c: pg.Client,
  sql: string,
  params: unknown[] = [],
) => (await c.query<T>(sql, params)).rows[0]!;

const reasonId = async (category: string, code: string): Promise<string> =>
  (
    await one<{ id: string }>(
      api,
      `SELECT id FROM sys.reason_codes WHERE category = $1 AND code = $2`,
      [category, code],
    )
  ).id;

/** A stock item and its id. */
async function stockItem(code: string, type = 'stock'): Promise<string> {
  return tx(
    async (c) =>
      (
        await one<{ id: string }>(
          c,
          `INSERT INTO md.items (code, item_type, name_ar, name_en, category_id, unit_id, vat_category_id)
           SELECT $1, $2, 'صنف', 'Item', c.id, u.id, v.id
             FROM md.item_categories c, md.units u, md.vat_categories v
            WHERE c.code = 'EQUIP' AND u.code = CASE WHEN $2 = 'service' THEN 'VISIT' ELSE 'KG' END
              AND v.code = 'SR'
           RETURNING id`,
          [code, type],
        )
      ).id,
    owner,
  );
}

interface Line {
  item: string;
  qty: string;
  cost?: string | null;
  status?: string;
  target?: string | null;
}

/**
 * Posts an adjustment the way the API does: a draft, its lines, one movement per line (two for a
 * status change), the line values from the movements, then the posting with the total.
 */
async function adjust(
  kind: string,
  reason: string,
  lines: Line[],
  userId: bigint,
  options: {
    date?: string;
    approval?: string | null;
    client?: pg.Client;
    /** A wrong total sent with the posting: the database must use its own. */
    claimedTotal?: string;
  } = {},
): Promise<{ id: string; doc_number: string; total: string }> {
  return tx(
    async (c) => {
      const doc = await one<{ id: string }>(
        c,
        `INSERT INTO inv.adjustments (kind, warehouse_id, adjustment_date, reason_code_id, approval_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [kind, warehouse, options.date ?? today, reason, options.approval ?? null],
      );
      let total = 0n;
      for (const [i, l] of lines.entries()) {
        const line = await one<{ id: string }>(
          c,
          `INSERT INTO inv.adjustment_lines (adjustment_id, line_no, item_id, stock_status, target_status,
                                             quantity, entered_unit_cost_4dp)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [doc.id, i + 1, l.item, l.status ?? 'available', l.target ?? null, l.qty, l.cost ?? null],
        );
        const inbound = ['opening', 'increase', 'oversell'].includes(kind);
        const type =
          kind === 'opening'
            ? 'opening'
            : kind === 'increase'
              ? 'adjustment_in'
              : kind === 'oversell'
                ? 'oversell_in'
                : kind === 'write_off'
                  ? 'write_off'
                  : kind === 'status_change'
                    ? 'status_out'
                    : 'adjustment_out';
        const qty = inbound ? l.qty : `-${l.qty}`;
        const value = inbound ? scaled(l.qty, BigInt(l.cost!)) : null;
        const m = await one<{ value_4dp: string; value_fils: string }>(
          c,
          `INSERT INTO inv.movements (movement_type, movement_date, item_id, warehouse_id, stock_status,
                                      quantity, value_4dp, adjustment_line_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING value_4dp::text, value_fils::text`,
          [
            type,
            options.date ?? today,
            l.item,
            warehouse,
            l.status ?? 'available',
            qty,
            value,
            line.id,
          ],
        );
        let lineFils = BigInt(m.value_fils);
        if (kind === 'status_change') {
          const back = await one<{ value_fils: string }>(
            c,
            `INSERT INTO inv.movements (movement_type, movement_date, item_id, warehouse_id, stock_status,
                                        quantity, value_4dp, adjustment_line_id)
             VALUES ('status_in', $1, $2, $3, $4, $5, $6, $7) RETURNING value_fils::text`,
            [
              options.date ?? today,
              l.item,
              warehouse,
              l.target,
              l.qty,
              -BigInt(m.value_4dp),
              line.id,
            ],
          );
          lineFils = BigInt(back.value_fils);
        }
        await c.query(
          `UPDATE inv.adjustment_lines SET value_4dp = $2, value_fils = $3 WHERE id = $1`,
          [line.id, m.value_4dp, lineFils],
        );
        total += lineFils;
      }
      return one<{ id: string; doc_number: string; total: string }>(
        c,
        `UPDATE inv.adjustments SET status = 'posted', total_value_fils = $2 WHERE id = $1
         RETURNING id, doc_number, total_value_fils::text AS total`,
        [doc.id, options.claimedTotal ?? total],
      );
    },
    userId,
    options.client,
  );
}

/** qty (text with up to 3 decimals) × unit cost (4 dp), rounded half away from zero to 4 dp. */
function scaled(qty: string, cost: bigint): bigint {
  const [whole = '0', fraction = ''] = qty.split('.');
  const milli = BigInt(whole) * 1000n + BigInt((fraction + '000').slice(0, 3));
  const n = milli * cost;
  return (n + 500n) / 1000n;
}

const balance = (item: string, status = 'available') =>
  one<{ quantity: string; value_4dp: string; book_value_fils: string; avg: string | null }>(
    api,
    `SELECT quantity::text, value_4dp::text, book_value_fils::text, avg_unit_cost_4dp::text AS avg
       FROM inv.balances WHERE item_id = $1 AND warehouse_id = $2 AND stock_status = $3`,
    [item, warehouse, status],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  admin = await db.connect('superuser');
  owner = await createUser(api, {
    username: 'owner.inv',
    roles: ['owner'],
    signInMethod: 'password_totp',
  });
  accountant = await createUser(api, { username: 'acc.inv', roles: ['accountant'], withPin: true });
  storekeeper = await createUser(api, { username: 'store.inv', roles: ['storekeeper'] });
  device = await createDevice(api, { code: 'OFFICE-INV' });
  warehouse = (await one<{ id: string }>(api, `SELECT id FROM md.warehouses WHERE code = 'MAIN'`))
    .id;
  today = (await one<{ d: string }>(api, `SELECT sys.business_date()::text AS d`)).d;
});
afterAll(() => db.drop());

describe('the movement engine', () => {
  it('keeps the average to 4 decimals; the last unit takes exactly what remains; books end at 0.00', async () => {
    const item = await stockItem('INV-0001');
    const opening = await reasonId('other', 'OPENING');
    const damaged = await reasonId('stock_decrease', 'DAMAGED');

    const first = await adjust('opening', opening, [{ item, qty: '10', cost: '12345' }], owner);
    expect(first.doc_number).toMatch(/^ADJ-/);
    expect(first.total).toBe('1235');
    expect(await balance(item)).toEqual({
      quantity: '10.000',
      value_4dp: '123450',
      book_value_fils: '1235',
      avg: '12345',
    });

    const out3 = await adjust('decrease', damaged, [{ item, qty: '3' }], storekeeper);
    expect(out3.total).toBe('-371'); // 12.35 → 8.64
    expect(await balance(item)).toMatchObject({
      value_4dp: '86415',
      book_value_fils: '864',
      avg: '12345',
    });

    const out7 = await adjust('decrease', damaged, [{ item, qty: '7' }], storekeeper);
    expect(out7.total).toBe('-864');
    // Nothing left, exactly; the last average is kept (it values an oversell later).
    expect(await balance(item)).toEqual({
      quantity: '0.000',
      value_4dp: '0',
      book_value_fils: '0',
      avg: '12345',
    });
    const sums = await one<{ fils: string; v: string }>(
      api,
      `SELECT sum(value_fils)::text AS fils, sum(value_4dp)::text AS v FROM inv.movements WHERE item_id = $1`,
      [item],
    );
    expect(sums).toEqual({ fils: '0', v: '0' });
  });

  it('refuses stock below zero, and nothing of the document is saved', async () => {
    const item = await stockItem('INV-0002');
    await adjust(
      'opening',
      await reasonId('other', 'OPENING'),
      [{ item, qty: '2', cost: '10000' }],
      owner,
    );
    await expect(
      adjust(
        'decrease',
        await reasonId('stock_decrease', 'DAMAGED'),
        [{ item, qty: '2.5' }],
        storekeeper,
      ),
    ).rejects.toMatchObject(rule('STOCK_INSUFFICIENT'));
    expect(await balance(item)).toMatchObject({ quantity: '2.000' });
    const { rows } = await api.query(
      `SELECT 1 FROM inv.adjustments WHERE kind = 'decrease' AND status <> 'posted'`,
    );
    expect(rows).toEqual([]);
  });

  it('20 people asking for the last 5 units at the same time: exactly 5 succeed', async () => {
    const item = await stockItem('INV-0003');
    await adjust(
      'opening',
      await reasonId('other', 'OPENING'),
      [{ item, qty: '5', cost: '20000' }],
      owner,
    );
    const damaged = await reasonId('stock_decrease', 'DAMAGED');
    const clients = await Promise.all(Array.from({ length: 20 }, () => db.connect('api')));
    try {
      const results = await Promise.allSettled(
        clients.map((client) =>
          adjust('decrease', damaged, [{ item, qty: '1' }], storekeeper, { client }),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter(
        (r) =>
          r.status === 'rejected' && (r.reason as { hint?: string }).hint === 'STOCK_INSUFFICIENT',
      );
      expect(ok).toHaveLength(5);
      expect(refused).toHaveLength(15);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    expect(await balance(item)).toMatchObject({
      quantity: '0.000',
      value_4dp: '0',
      book_value_fils: '0',
    });
  });

  it('keeps every balance equal to the sum of its movements', async () => {
    const { rows } = await api.query(
      `SELECT b.item_id FROM inv.balances b
         LEFT JOIN (SELECT item_id, warehouse_id, stock_status, sum(quantity) q, sum(value_4dp) v, sum(value_fils) f
                      FROM inv.movements GROUP BY 1, 2, 3) m USING (item_id, warehouse_id, stock_status)
        WHERE b.quantity <> coalesce(m.q, 0) OR b.value_4dp <> coalesce(m.v, 0) OR b.book_value_fils <> coalesce(m.f, 0)`,
    );
    expect(rows).toEqual([]);
  });

  it('services have no stock; movements are final; balances are written only by the database', async () => {
    const service = await stockItem('INV-SV01', 'service');
    await expect(
      adjust(
        'opening',
        await reasonId('other', 'OPENING'),
        [{ item: service, qty: '1', cost: '1' }],
        owner,
      ),
    ).rejects.toMatchObject(rule('STOCK_ITEM_ONLY'));
    await expect(api.query(`UPDATE inv.balances SET quantity = 99`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(api.query(`UPDATE inv.movements SET quantity = 99`)).rejects.toMatchObject({
      code: '42501',
    });
    // Not even the database superuser can change a movement (it is final).
    await expect(
      inContext(admin, () => admin.query(`UPDATE inv.movements SET quantity = quantity + 1`)),
    ).rejects.toMatchObject({ code: 'AP003' });
    await expect(admin.query(`DELETE FROM inv.movements`)).rejects.toBeTruthy();
  });

  it('a movement dated in a closed or missing month is refused', async () => {
    const item = await stockItem('INV-0004');
    await expect(
      adjust(
        'opening',
        await reasonId('other', 'OPENING'),
        [{ item, qty: '1', cost: '1' }],
        owner,
        {
          date: '2019-01-15',
        },
      ),
    ).rejects.toMatchObject(rule('PERIOD_NOT_OPEN'));
  });
});

describe('adjustments (ADJ-)', () => {
  it('need a reason of their own kind, and at least one line', async () => {
    const item = await stockItem('INV-0101');
    await expect(
      adjust(
        'opening',
        await reasonId('stock_decrease', 'DAMAGED'),
        [{ item, qty: '1', cost: '1' }],
        owner,
      ),
    ).rejects.toMatchObject(rule('ADJUSTMENT_REASON'));
    await expect(
      adjust('decrease', await reasonId('stock_decrease', 'DAMAGED'), [], storekeeper),
    ).rejects.toMatchObject(rule('ADJUSTMENT_EMPTY'));
  });

  it('opening stock is posted by the owner only (decision 0042)', async () => {
    const item = await stockItem('INV-0102');
    await expect(
      adjust(
        'opening',
        await reasonId('other', 'OPENING'),
        [{ item, qty: '1', cost: '100' }],
        accountant,
      ),
    ).rejects.toMatchObject(denied('OPENING_OWNER_ONLY'));
  });

  it('opening stock is posted once per item (decision 0042); later changes are adjustments', async () => {
    const item = await stockItem('INV-0109');
    const other = await stockItem('INV-0110');
    const opening = await reasonId('other', 'OPENING');
    await adjust('opening', opening, [{ item, qty: '1', cost: '100' }], owner);
    await expect(
      adjust(
        'opening',
        opening,
        [
          { item: other, qty: '1', cost: '100' },
          { item, qty: '1', cost: '100' },
        ],
        owner,
      ),
    ).rejects.toMatchObject(rule('OPENING_ALREADY_POSTED'));
    // An item forgotten at go-live still gets its opening stock.
    await adjust('opening', opening, [{ item: other, qty: '1', cost: '100' }], owner);
  });

  it('the approval threshold uses the value of the movements, never the total sent', async () => {
    const item = await stockItem('INV-0111');
    const found = await reasonId('stock_increase', 'FOUND');
    await expect(
      adjust('increase', found, [{ item, qty: '6', cost: '1000000' }], storekeeper, {
        claimedTotal: '0',
      }),
    ).rejects.toMatchObject(denied('APPROVAL_REQUIRED'));
    const small = await adjust(
      'increase',
      found,
      [{ item, qty: '1', cost: '1000000' }],
      storekeeper,
      {
        claimedTotal: '5',
      },
    );
    expect(small.total).toBe('10000');
  });

  it('stock never moves for a posted document or another item than its line', async () => {
    const item = await stockItem('INV-0112');
    const other = await stockItem('INV-0113');
    const posted = await adjust(
      'opening',
      await reasonId('other', 'OPENING'),
      [{ item, qty: '2', cost: '100' }],
      owner,
    );
    const line = (
      await one<{ id: string }>(
        api,
        `SELECT id FROM inv.adjustment_lines WHERE adjustment_id = $1`,
        [posted.id],
      )
    ).id;
    const move = (itemId: string) =>
      tx(
        (c) =>
          c.query(
            `INSERT INTO inv.movements (movement_type, movement_date, item_id, warehouse_id, stock_status,
                                        quantity, value_4dp, adjustment_line_id)
             VALUES ('opening', $1, $2, $3, 'available', 1, 100, $4)`,
            [today, itemId, warehouse, line],
          ),
        owner,
      );
    await expect(move(item)).rejects.toMatchObject(rule('DOCUMENT_STEP'));
    await expect(move(other)).rejects.toMatchObject(rule('DOCUMENT_STEP'));
    expect((await balance(item)).quantity).toBe('2.000');
  });

  it('above the threshold (500.00 AED) need an approval (decision 0041)', async () => {
    const item = await stockItem('INV-0103');
    const found = await reasonId('stock_increase', 'FOUND');
    // 6 × 100.00 = 600.00 > 500.00
    await expect(
      adjust('increase', found, [{ item, qty: '6', cost: '1000000' }], storekeeper),
    ).rejects.toMatchObject(denied('APPROVAL_REQUIRED'));
    const approval = await tx(
      async (c) =>
        (
          await one<{ id: string }>(
            c,
            `INSERT INTO auth.approvals (permission_code, approved_by, reason_text)
             VALUES ('stock.adjust_over_threshold', $1, 'Found a full box') RETURNING id`,
            [accountant],
          )
        ).id,
      storekeeper,
    );
    const posted = await adjust(
      'increase',
      found,
      [{ item, qty: '6', cost: '1000000' }],
      storekeeper,
      {
        approval,
      },
    );
    expect(posted.total).toBe('60000');
    // 5 × 100.00 = 500.00 exactly: no approval needed.
    const small = await adjust(
      'increase',
      found,
      [{ item, qty: '5', cost: '1000000' }],
      storekeeper,
    );
    expect(small.total).toBe('50000');
  });

  it('are numbered without gaps when posted, and never change afterwards', async () => {
    const item = await stockItem('INV-0104');
    const opening = await reasonId('other', 'OPENING');
    const a = await adjust('opening', opening, [{ item, qty: '1', cost: '100' }], owner);
    // A failed posting uses no number.
    await expect(
      adjust(
        'decrease',
        await reasonId('stock_decrease', 'DAMAGED'),
        [{ item, qty: '5' }],
        storekeeper,
      ),
    ).rejects.toBeTruthy();
    const b = await adjust(
      'increase',
      await reasonId('stock_increase', 'FOUND'),
      [{ item, qty: '1', cost: '100' }],
      storekeeper,
    );
    const n = (doc: string) => Number(doc.replace(/\D/g, ''));
    expect(n(b.doc_number)).toBe(n(a.doc_number) + 1);
    await expect(
      tx(
        (c) => c.query(`UPDATE inv.adjustments SET note = 'changed' WHERE id = $1`, [a.id]),
        owner,
      ),
    ).rejects.toMatchObject({ code: 'AP003' });
    await expect(
      tx(
        (c) =>
          c.query(
            `INSERT INTO inv.adjustment_lines (adjustment_id, line_no, item_id, quantity, entered_unit_cost_4dp)
             VALUES ($1, 9, $2, 1, 1)`,
            [a.id, item],
          ),
        owner,
      ),
    ).rejects.toMatchObject({ code: 'AP006' });
  });

  it('move goods to defective at the same value, and write them off from there (decision 0015)', async () => {
    const item = await stockItem('INV-0105');
    await adjust(
      'opening',
      await reasonId('other', 'OPENING'),
      [{ item, qty: '4', cost: '25000' }],
      owner,
    );
    const moved = await adjust(
      'status_change',
      await reasonId('defective', 'BROKEN'),
      [{ item, qty: '1', status: 'available', target: 'defective' }],
      storekeeper,
    );
    expect(moved.total).toBe('250');
    expect(await balance(item, 'defective')).toMatchObject({
      quantity: '1.000',
      value_4dp: '25000',
    });
    expect(await balance(item, 'available')).toMatchObject({
      quantity: '3.000',
      value_4dp: '75000',
    });
    // Only defective goods are written off.
    await expect(
      adjust('write_off', await reasonId('write_off', 'SCRAPPED'), [{ item, qty: '1' }], owner),
    ).rejects.toMatchObject(rule('ADJUSTMENT_LINE'));
    const gone = await adjust(
      'write_off',
      await reasonId('write_off', 'SCRAPPED'),
      [{ item, qty: '1', status: 'defective' }],
      owner,
    );
    expect(gone.total).toBe('-250');
    expect(await balance(item, 'defective')).toMatchObject({ quantity: '0.000', value_4dp: '0' });
  });

  it('an oversell is reviewed once, with a note; who and when are stamped (decision 0003)', async () => {
    const item = await stockItem('INV-0106');
    const approval = await tx(
      async (c) =>
        (
          await one<{ id: string }>(
            c,
            `INSERT INTO auth.approvals (permission_code, approved_by, reason_text)
             VALUES ('pos.oversell', $1, 'Customer waiting') RETURNING id`,
            [accountant],
          )
        ).id,
      storekeeper,
    );
    // The POS (M5) creates oversells inside the sale; here the sale is a draft invoice.
    const doc = await tx(async (c) => {
      const sale = await one<{ id: string }>(
        c,
        `INSERT INTO sales.documents (doc_type, channel, branch_id, business_line_id, warehouse_id, device_id,
                                     customer_id, bill_to_name)
         SELECT 'invoice', 'office', (SELECT id FROM sys.branches ORDER BY id LIMIT 1),
                (SELECT id FROM md.business_lines ORDER BY id LIMIT 1), w.id, sys.ctx_device_id(), c.id, c.name
           FROM md.warehouses w, md.customers c WHERE w.code = 'MAIN' AND c.is_walk_in RETURNING id`,
      );
      const d = await one<{ id: string; review_status: string }>(
        c,
        `INSERT INTO inv.adjustments (kind, warehouse_id, adjustment_date, reason_code_id, approval_id, sales_document_id)
         VALUES ('oversell', $1, $2, $3, $4, $5) RETURNING id, review_status`,
        [warehouse, today, await reasonId('oversell', 'OVERSELL'), approval, sale.id],
      );
      const line = await one<{ id: string }>(
        c,
        `INSERT INTO inv.adjustment_lines (adjustment_id, line_no, item_id, quantity, entered_unit_cost_4dp)
         VALUES ($1, 1, $2, 2, 30000) RETURNING id`,
        [d.id, item],
      );
      const m = await one<{ value_fils: string }>(
        c,
        `INSERT INTO inv.movements (movement_type, movement_date, item_id, warehouse_id, stock_status, quantity, value_4dp, adjustment_line_id)
         VALUES ('oversell_in', $1, $2, $3, 'available', 2, 60000, $4) RETURNING value_fils::text`,
        [today, item, warehouse, line.id],
      );
      await c.query(
        `UPDATE inv.adjustments SET status = 'posted', total_value_fils = $2 WHERE id = $1`,
        [d.id, m.value_fils],
      );
      return d;
    }, storekeeper);
    expect(doc.review_status).toBe('pending');
    await expect(
      tx(
        (c) =>
          c.query(`UPDATE inv.adjustments SET review_status = 'reviewed' WHERE id = $1`, [doc.id]),
        storekeeper,
      ),
    ).rejects.toMatchObject({ code: '23514' }); // a note is required
    const reviewed = await tx(
      (c) =>
        one<{ reviewed_by: string; reviewed_at: string | null }>(
          c,
          `UPDATE inv.adjustments SET review_status = 'reviewed', review_note = 'Shelf was miscounted'
            WHERE id = $1 RETURNING reviewed_by::text, reviewed_at`,
          [doc.id],
        ),
      storekeeper,
    );
    expect(reviewed.reviewed_by).toBe(storekeeper.toString());
    expect(reviewed.reviewed_at).not.toBeNull();
    await expect(
      tx(
        (c) =>
          c.query(`UPDATE inv.adjustments SET review_status = 'pending' WHERE id = $1`, [doc.id]),
        storekeeper,
      ),
    ).rejects.toMatchObject(rule('REVIEW_STEP'));
  });
});

describe('counts (CNT-, decision 0044)', () => {
  it('one open count per warehouse; every line counted before posting; numbered when posted', async () => {
    const item = await stockItem('INV-0201');
    await adjust(
      'opening',
      await reasonId('other', 'OPENING'),
      [{ item, qty: '8', cost: '10000' }],
      owner,
    );
    const count = await tx(async (c) => {
      const k = await one<{ id: string; snapshot_at: string | null }>(
        c,
        `INSERT INTO inv.counts (warehouse_id, scope) VALUES ($1, 'selected') RETURNING id, snapshot_at`,
        [warehouse],
      );
      await c.query(
        `INSERT INTO inv.count_lines (count_id, item_id, system_qty) VALUES ($1, $2, 8)`,
        [k.id, item],
      );
      return k;
    }, storekeeper);
    expect(count.snapshot_at).not.toBeNull();
    await expect(
      tx(
        (c) =>
          c.query(`INSERT INTO inv.counts (warehouse_id, scope) VALUES ($1, 'full')`, [warehouse]),
        storekeeper,
      ),
    ).rejects.toMatchObject({ code: '23505' });
    const post = (approval: string | null = null) =>
      tx(
        (c) =>
          one<{ doc_number: string }>(
            c,
            `UPDATE inv.counts SET status = 'posted', count_date = $2, total_value_fils = 0, variance_abs_fils = 0,
                    approval_id = $3
              WHERE id = $1 RETURNING doc_number`,
            [count.id, today, approval],
          ),
        storekeeper,
      );
    await expect(post()).rejects.toMatchObject(rule('COUNT_INCOMPLETE'));
    const counted = await tx(
      (c) =>
        one<{ counted_by: string }>(
          c,
          `UPDATE inv.count_lines SET counted_qty = 8 WHERE count_id = $1 RETURNING counted_by::text`,
          [count.id],
        ),
      storekeeper,
    );
    expect(counted.counted_by).toBe(storekeeper.toString());
    expect((await post()).doc_number).toMatch(/^CNT-/);
    await expect(
      tx(
        (c) =>
          c.query(`UPDATE inv.count_lines SET counted_qty = 7 WHERE count_id = $1`, [count.id]),
        storekeeper,
      ),
    ).rejects.toMatchObject({ code: 'AP006' });
  });

  it('a difference worth more than the threshold needs an approval, whatever value is sent', async () => {
    const item = await stockItem('INV-0310');
    await adjust(
      'opening',
      await reasonId('other', 'OPENING'),
      [{ item, qty: '10', cost: '1000000' }],
      owner,
    ); // 10 × 100.00
    const count = await tx(
      (c) =>
        one<{ id: string }>(
          c,
          `INSERT INTO inv.counts (warehouse_id, scope) VALUES ($1, 'full') RETURNING id`,
          [warehouse],
        ),
      storekeeper,
    );
    const line = await tx(
      (c) =>
        one<{ id: string }>(
          c,
          `INSERT INTO inv.count_lines (count_id, item_id, stock_status, system_qty)
           VALUES ($1, $2, 'available', 10) RETURNING id`,
          [count.id, item],
        ),
      storekeeper,
    );
    await tx(
      (c) => c.query(`UPDATE inv.count_lines SET counted_qty = 4 WHERE id = $1`, [line.id]),
      storekeeper,
    );
    // 6 missing × 100.00 = 600.00, but the posting claims there is no difference at all.
    await expect(
      tx(async (c) => {
        await c.query(
          `INSERT INTO inv.movements (movement_type, movement_date, item_id, warehouse_id, stock_status,
                                      quantity, count_line_id)
           VALUES ('count_loss', $1, $2, $3, 'available', -6, $4)`,
          [today, item, warehouse, line.id],
        );
        return c.query(
          `UPDATE inv.counts SET status = 'posted', count_date = $2, total_value_fils = 0,
                  variance_abs_fils = 0 WHERE id = $1`,
          [count.id, today],
        );
      }, storekeeper),
    ).rejects.toMatchObject(denied('APPROVAL_REQUIRED'));
    await tx(
      (c) => c.query(`UPDATE inv.counts SET status = 'cancelled' WHERE id = $1`, [count.id]),
      storekeeper,
    );
    // A cancelled count moves no stock.
    await expect(
      tx(
        (c) =>
          c.query(
            `INSERT INTO inv.movements (movement_type, movement_date, item_id, warehouse_id, stock_status,
                                        quantity, count_line_id)
             VALUES ('count_loss', $1, $2, $3, 'available', -6, $4)`,
            [today, item, warehouse, line.id],
          ),
        storekeeper,
      ),
    ).rejects.toMatchObject(rule('DOCUMENT_STEP'));
    expect((await balance(item)).quantity).toBe('10.000');
  });
});

describe('barcode label sizes (decision 0043)', () => {
  it('has the eight agreed sizes; the owner can add more; none is deleted', async () => {
    const { rows } = await api.query<{ code: string }>(
      `SELECT code FROM md.label_sizes WHERE is_active ORDER BY sort_order`,
    );
    expect(rows.map((r) => r.code)).toEqual([
      '25X15',
      '30X20',
      '38X25',
      '40X30',
      '50X25',
      '50X30',
      '58X40',
      '100X50',
    ]);
    await tx(
      (c) =>
        c.query(
          `INSERT INTO md.label_sizes (code, name_ar, name_en, width_mm, height_mm) VALUES ('SHELF', 'ملصق الرف', 'Shelf label', 70, 35)`,
        ),
      owner,
    );
    await expect(
      api.query(`DELETE FROM md.label_sizes WHERE code = 'SHELF'`),
    ).rejects.toMatchObject({
      code: '42501',
    });
  });
});
