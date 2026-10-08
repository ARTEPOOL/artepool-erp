/**
 * Migration 0008: the provisional chart of accounts (decisions 0018, 0035), the account used for
 * each event, and monthly periods with close and lock (decision 0016).
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
let accountant: bigint;

/** Runs one statement as `userId` (with an optional reason) and commits. */
async function run(sql: string, params: unknown[] = [], userId = 1n, reason: string | null = null) {
  await api.query('BEGIN');
  try {
    await setContext(api, userId, reason);
    const result = await api.query(sql, params);
    await api.query('COMMIT');
    return result;
  } catch (error) {
    await api.query('ROLLBACK');
    throw error;
  }
}

const accountId = async (code: string): Promise<string> =>
  (await api.query<{ id: string }>('SELECT id FROM gl.accounts WHERE code = $1', [code])).rows[0]!
    .id;

const addAccount = async (
  code: string,
  parent: string | null,
  type = 'expense',
  postable = true,
  control = false,
) =>
  run(
    `INSERT INTO gl.accounts (code, name_ar, name_en, account_type, parent_id, is_postable, is_control)
     VALUES ($1, 'حساب', 'Account', $2, (SELECT id FROM gl.accounts WHERE code = $3), $4, $5)
     RETURNING id`,
    [code, type, parent, postable, control],
  );

const setMapping = (key: string, code: string) =>
  run(
    `UPDATE gl.account_mappings SET account_id = (SELECT id FROM gl.accounts WHERE code = $2)
      WHERE key = $1`,
    [key, code],
  );

const rule = (hint: string) => ({ code: 'AP011', hint });

/** As the database superuser (no grants apply, but every rule and trigger still does). */
const asAdmin = (sql: string, params: unknown[] = []) =>
  inContext(admin, () => admin.query(sql, params));

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  admin = await db.connect('superuser');
  accountant = await createUser(api, { username: 'acc.user', roles: ['accountant'] });
});
afterAll(() => db.drop());

describe('the provisional chart of accounts', () => {
  it('is seeded from the chart for the accountant, with headers, control and contra accounts', async () => {
    const { rows } = await api.query<{ code: string; parent: string | null; flags: string }>(
      `SELECT a.code, p.code AS parent,
              concat_ws(',', CASE WHEN NOT a.is_postable THEN 'header' END,
                        CASE WHEN a.is_control THEN 'control' END,
                        CASE WHEN a.is_contra THEN 'contra' END) AS flags
         FROM gl.accounts AS a LEFT JOIN gl.accounts AS p ON p.id = a.parent_id ORDER BY a.code`,
    );
    expect(rows).toHaveLength(75);
    expect(rows.filter((r) => r.flags === 'header')).toHaveLength(13);
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(byCode['1210']).toEqual({ code: '1210', parent: '1200', flags: 'control' });
    expect(byCode['2110']).toEqual({ code: '2110', parent: '2100', flags: 'control' });
    expect(byCode['1590']).toEqual({ code: '1590', parent: '1500', flags: 'contra' });
    expect(byCode['4100']).toEqual({ code: '4100', parent: '4000', flags: '' });
    expect(byCode['6110']).toEqual({ code: '6110', parent: '6000', flags: '' });
    expect(rows.filter((r) => r.parent === null).map((r) => r.code)).toEqual([
      '1000',
      '2000',
      '3000',
      '4000',
      '5000',
      '6000',
    ]);
  });

  it('links every event to the agreed account', async () => {
    const { rows } = await api.query<{ key: string; code: string }>(
      `SELECT m.key, a.code FROM gl.account_mappings AS m JOIN gl.accounts AS a ON a.id = m.account_id
        ORDER BY m.key`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.key, r.code]))).toEqual({
      ap_control: '2110',
      ar_control: '1210',
      cash_in_safe: '1120',
      cash_over_short: '6910',
      customer_advances: '2120',
      inventory: '1310',
      inventory_defective: '1320',
      opening_balance_equity: '3900',
      stock_adjustments: '5600',
      vat_input: '1410',
      vat_output: '2130',
      write_off: '5700',
    });
  });

  it('keeps the tree sound: header parents of the same type, no loops', async () => {
    await expect(addAccount('6911', '6910')).rejects.toMatchObject(
      rule('ACCOUNT_PARENT_NOT_HEADER'),
    );
    await expect(addAccount('6995', '6000', 'revenue')).rejects.toMatchObject(
      rule('ACCOUNT_PARENT_TYPE'),
    );
    await addAccount('6050', '6000', 'expense', false);
    await addAccount('6051', '6050');
    await expect(
      run(`UPDATE gl.accounts SET parent_id = $1 WHERE code = '6050'`, [await accountId('6050')]),
    ).rejects.toMatchObject(rule('ACCOUNT_LOOP'));
    await addAccount('6052', '6050', 'expense', false);
    await expect(
      run(`UPDATE gl.accounts SET parent_id = $1 WHERE code = '6050'`, [await accountId('6052')]),
    ).rejects.toMatchObject(rule('ACCOUNT_LOOP'));
    await expect(
      run(`UPDATE gl.accounts SET is_postable = true WHERE code = '6050'`),
    ).rejects.toMatchObject(rule('ACCOUNT_HAS_CHILDREN'));
    await expect(
      run(`UPDATE gl.accounts SET is_active = false WHERE code = '6050'`),
    ).rejects.toMatchObject(rule('ACCOUNT_HAS_CHILDREN'));
  });

  it('lets an unused account be renamed, moved and deactivated, but nothing goes under an inactive header', async () => {
    await run(`UPDATE gl.accounts SET name_en = 'Sundry' WHERE code = '6051'`);
    await run(`UPDATE gl.accounts SET is_active = false WHERE code IN ('6051', '6052')`);
    await run(`UPDATE gl.accounts SET is_active = false WHERE code = '6050'`);
    await expect(addAccount('6053', '6050')).rejects.toMatchObject(rule('ACCOUNT_PARENT_INACTIVE'));
    await expect(
      run(`UPDATE gl.accounts SET is_active = true WHERE code = '6051'`),
    ).rejects.toMatchObject(rule('ACCOUNT_PARENT_INACTIVE'));
  });

  it('protects an account used by an event: type, header, control and active state stay', async () => {
    // (A type change is refused earlier anyway: a sub-account keeps its header's type.)
    for (const change of [`is_active = false`, `is_postable = false`, `is_control = true`]) {
      await expect(
        run(`UPDATE gl.accounts SET ${change} WHERE code = '6910'`),
      ).rejects.toMatchObject({ ...rule('ACCOUNT_IN_USE'), detail: 'event_link' });
    }
    await run(`UPDATE gl.accounts SET name_ar = 'فروقات النقدية' WHERE code = '6910'`);
  });

  it('is never deleted', async () => {
    await expect(run(`DELETE FROM gl.accounts WHERE code = '6990'`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(asAdmin(`DELETE FROM gl.accounts WHERE code = '6990'`)).rejects.toMatchObject({
      code: 'AP002',
    });
  });
});

describe('event links (mappings)', () => {
  it('point only to an active, postable account of the right kind', async () => {
    await expect(setMapping('cash_over_short', '6000')).rejects.toMatchObject(
      rule('MAPPING_ACCOUNT_INVALID'),
    );
    await expect(setMapping('cash_over_short', '6051')).rejects.toMatchObject(
      rule('MAPPING_ACCOUNT_INVALID'),
    );
    await expect(setMapping('vat_output', '1410')).rejects.toMatchObject(
      rule('MAPPING_ACCOUNT_INVALID'),
    );
    await expect(setMapping('stock_adjustments', '1210')).rejects.toMatchObject(
      rule('MAPPING_ACCOUNT_INVALID'),
    );
    await expect(setMapping('ar_control', '1230')).rejects.toMatchObject(
      rule('MAPPING_ACCOUNT_INVALID'),
    );
  });

  it('can be moved to another valid account, which is audited, and the old one is free again', async () => {
    await run(`UPDATE gl.accounts SET is_active = true WHERE code = '6050'`);
    await run(`UPDATE gl.accounts SET is_active = true WHERE code = '6051'`);
    await setMapping('cash_over_short', '6051');
    const { rows } = await api.query<{ old_values: object; new_values: object }>(
      `SELECT old_values, new_values FROM audit.log
        WHERE entity_type = 'gl.account_mappings' AND entity_id = 'cash_over_short'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]).toEqual({
      old_values: { account_id: Number(await accountId('6910')) },
      new_values: { account_id: Number(await accountId('6051')) },
    });
    await run(`UPDATE gl.accounts SET is_active = false WHERE code = '6910'`);
    await run(`UPDATE gl.accounts SET is_active = true WHERE code = '6910'`);
    await setMapping('cash_over_short', '6910');
  });

  it('keep their key and kind, and cannot be added or deleted by the API', async () => {
    await expect(
      run(`UPDATE gl.account_mappings SET required_type = 'asset' WHERE key = 'write_off'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      run(
        `INSERT INTO gl.account_mappings (key, account_id, required_type, needs_control)
         SELECT 'write_off', id, 'expense', false FROM gl.accounts WHERE code = '5700'`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(run(`DELETE FROM gl.account_mappings`)).rejects.toMatchObject({ code: '42501' });
  });
});

describe('monthly periods (decisions 0016, 0035)', () => {
  it('exist from January of this year up to 3 months ahead, one after another', async () => {
    const { rows } = await api.query<{
      first: string;
      last: string;
      months: number;
      years_ok: boolean;
      gapless: boolean;
    }>(
      `SELECT min(period_start)::text AS first, max(period_start)::text AS last, count(*)::int AS months,
              bool_and(fiscal_year = extract(year FROM period_start)) AS years_ok,
              count(*) = (extract(year FROM age(max(period_start), min(period_start))) * 12
                          + extract(month FROM age(max(period_start), min(period_start))) + 1) AS gapless
         FROM gl.periods`,
    );
    const today = (await api.query<{ d: string }>(`SELECT sys.business_date(now())::text AS d`))
      .rows[0]!.d;
    const [year, month] = today.split('-').map(Number) as [number, number];
    const ahead = new Date(Date.UTC(year, month - 1 + 3, 1)).toISOString().slice(0, 10);
    expect(rows[0]).toEqual({
      first: `${year}-01-01`,
      last: ahead,
      months: month + 3,
      years_ok: true,
      gapless: true,
    });
  });

  it('are created only by the daily top-up, never by hand or with a gap', async () => {
    expect((await run(`SELECT gl.ensure_periods(3) AS n`)).rows[0]).toEqual({ n: 0 });
    const gap = `INSERT INTO gl.periods (period_start, period_end, fiscal_year)
                 VALUES ('2040-01-01', '2040-01-31', 2040)`;
    await expect(run(gap)).rejects.toMatchObject({ code: '42501' });
    await expect(asAdmin(gap)).rejects.toMatchObject(rule('PERIOD_GAP'));
    await expect(run(`SELECT gl.ensure_periods(30)`)).rejects.toMatchObject({ code: '22023' });
  });

  it('cannot close the current month before it ends', async () => {
    await expect(
      run(
        `UPDATE gl.periods SET status = 'closed'
          WHERE period_start = date_trunc('month', sys.business_date(now()))::date`,
        [],
        accountant,
      ),
    ).rejects.toMatchObject(rule('PERIOD_NOT_ENDED'));
  });

  describe('closing and locking (on months that have ended)', () => {
    const month = (start: string) =>
      api
        .query<{ id: string }>(`SELECT id FROM gl.periods WHERE period_start = $1`, [start])
        .then((r) => r.rows[0]!.id);
    const setStatus = async (start: string, status: string, reason: string | null = null) =>
      run(
        `UPDATE gl.periods SET status = $2 WHERE id = $1`,
        [await month(start), status],
        accountant,
        reason,
      );
    const statusOf = async (start: string) =>
      (
        await api.query<{ status: string; closed_by: string | null; locked_by: string | null }>(
          `SELECT status, closed_by, locked_by FROM gl.periods WHERE period_start = $1`,
          [start],
        )
      ).rows[0];

    beforeAll(async () => {
      // A history of ended months in 2020, so these tests never depend on today's date.
      await admin.query(`BEGIN; SET LOCAL session_replication_role = replica;
        DELETE FROM gl.periods;
        INSERT INTO gl.periods (period_start, period_end, fiscal_year, created_by, updated_by)
        SELECT d::date, (d + interval '1 month' - interval '1 day')::date, 2020, 1, 1
          FROM generate_series('2020-01-01'::date, '2020-04-01'::date, interval '1 month') AS d;
        COMMIT;`);
    });

    it('closes months in order and records who closed them', async () => {
      await expect(setStatus('2020-02-01', 'closed')).rejects.toMatchObject(rule('PERIOD_ORDER'));
      for (const start of ['2020-01-01', '2020-02-01', '2020-03-01', '2020-04-01']) {
        await setStatus(start, 'closed');
      }
      expect(await statusOf('2020-01-01')).toEqual({
        status: 'closed',
        closed_by: accountant.toString(),
        locked_by: null,
      });
    });

    it('reopens a closed month only with a reason, latest month first', async () => {
      await expect(setStatus('2020-04-01', 'open')).rejects.toMatchObject(rule('REASON_REQUIRED'));
      await expect(setStatus('2020-03-01', 'open', 'Missed invoice')).rejects.toMatchObject(
        rule('PERIOD_ORDER'),
      );
      await setStatus('2020-04-01', 'open', 'Missed invoice');
      expect(await statusOf('2020-04-01')).toEqual({
        status: 'open',
        closed_by: null,
        locked_by: null,
      });
    });

    it('locks only closed months, in order, and a locked month is final', async () => {
      await expect(setStatus('2020-02-01', 'locked')).rejects.toMatchObject(rule('PERIOD_ORDER'));
      await setStatus('2020-01-01', 'locked');
      expect(await statusOf('2020-01-01')).toEqual({
        status: 'locked',
        closed_by: accountant.toString(),
        locked_by: accountant.toString(),
      });
      await expect(setStatus('2020-01-01', 'closed', 'Oops')).rejects.toMatchObject(
        rule('PERIOD_LOCKED'),
      );
      await expect(setStatus('2020-01-01', 'open', 'Oops')).rejects.toMatchObject(
        rule('PERIOD_LOCKED'),
      );
      await expect(setStatus('2020-04-01', 'locked')).rejects.toMatchObject(
        rule('PERIOD_STATUS_STEP'),
      );
    });

    it('never changes its dates, is never deleted, and every step is audited', async () => {
      await expect(
        asAdmin(
          `UPDATE gl.periods SET period_end = '2020-02-28' WHERE period_start = '2020-02-01'`,
        ),
      ).rejects.toMatchObject({ code: 'AP003' });
      await expect(
        asAdmin(`DELETE FROM gl.periods WHERE period_start = '2020-02-01'`),
      ).rejects.toMatchObject({ code: 'AP002' });
      const { rows } = await api.query<{ action: string; status: string; user_id: string }>(
        `SELECT action, new_values ->> 'status' AS status, user_id::text FROM audit.log
          WHERE entity_type = 'gl.periods' AND entity_id = $1 ORDER BY id`,
        [await month('2020-01-01')],
      );
      expect(rows).toEqual([
        { action: 'update', status: 'closed', user_id: accountant.toString() },
        { action: 'update', status: 'locked', user_id: accountant.toString() },
      ]);
    });
  });
});
