import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, inContext, setContext, type TestDatabase } from '@artepool/testing';
import vectors from '../test-vectors/rounding.json';

let db: TestDatabase;
let api: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
});
afterAll(() => db.drop());

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await api.query<{ v: T }>(sql, params);
  return rows[0]!.v;
}

describe('sys.round_div: the same rounding rule as the TypeScript money module', () => {
  it.each(vectors.round_div)('$n / $d = $q', async ({ n, d, q }) => {
    expect(await one('SELECT sys.round_div($1::numeric, $2::numeric)::text AS v', [n, d])).toBe(q);
  });

  it('refuses division by zero and fractions', async () => {
    await expect(api.query('SELECT sys.round_div(1, 0)')).rejects.toMatchObject({ code: '22012' });
    await expect(api.query('SELECT sys.round_div(1.5, 2)')).rejects.toMatchObject({
      code: '22023',
    });
  });
});

describe('sys.normalize_search: Arabic and English search keys', () => {
  it.each([
    ['أحمد', 'احمد'],
    ['إبراهيم', 'ابراهيم'],
    ['آمنة', 'امنه'],
    ['مستشفى', 'مستشفي'],
    ['مُضَخَّة', 'مضخه'],
    ['كـــلور', 'كلور'],
    ['مسؤول', 'مسوول'],
    ['شاطئ', 'شاطي'],
    ['کلر فارسی', 'كلر فارسي'],
    ['  Pool   PUMP ', 'pool pump'],
    ['١٢٣٤ ۵۶', '1234 56'],
  ])('%s → %s', async (input, expected) => {
    expect(await one('SELECT sys.normalize_search($1) AS v', [input])).toBe(expected);
  });
});

describe('sys.business_date: the business day in Al Ain', () => {
  it.each([
    ['2026-10-06T19:59:59Z', '2026-10-06'],
    ['2026-10-06T20:00:00Z', '2026-10-07'],
    ['2026-12-31T21:00:00Z', '2027-01-01'],
  ])('%s is %s in Dubai', async (at, day) => {
    expect(await one('SELECT sys.business_date($1::timestamptz)::text AS v', [at])).toBe(day);
  });
});

describe('request context', () => {
  it('requires a user', async () => {
    await expect(api.query('SELECT sys.set_context(NULL)')).rejects.toMatchObject({
      code: 'AP001',
    });
  });

  it('lives only for the current transaction', async () => {
    await api.query('BEGIN');
    await api.query(
      `SELECT sys.set_context(1, 7, 9, '00000000-0000-0000-0000-000000000042', '10.0.0.5',
                              '2026-10-07T08:00:00Z', 'testing', 11)`,
    );
    const { rows } = await api.query<Record<string, string>>(
      `SELECT sys.ctx_user_id()::text AS u, sys.ctx_device_id()::text AS d, sys.ctx_session_id()::text AS s,
              sys.ctx_request_id()::text AS r, host(sys.ctx_client_ip()) AS ip,
              sys.ctx_client_time() = '2026-10-07T08:00:00Z'::timestamptz AS t,
              sys.ctx_reason() AS reason, sys.ctx_approval_id()::text AS a`,
    );
    await api.query('COMMIT');
    expect(rows[0]).toEqual({
      u: '1',
      d: '7',
      s: '9',
      r: '00000000-0000-0000-0000-000000000042',
      ip: '10.0.0.5',
      t: true,
      reason: 'testing',
      a: '11',
    });
    expect(await one('SELECT sys.ctx_user_id() AS v')).toBeNull();
  });
});

describe('standard columns (who and when, optimistic locking)', () => {
  it('stamps creator, editor and version, and keeps the creator unchangeable', async () => {
    const tester = await inContext(api, async () => {
      const { rows } = await api.query<{ id: string }>(
        `INSERT INTO auth.users (username, display_name_ar, display_name_en, password_hash)
         VALUES ('tester', 'مختبر', 'Tester', '$argon2id$x') RETURNING id`,
      );
      return BigInt(rows[0]!.id);
    });
    const branch = await inContext(api, async () => {
      const { rows } = await api.query<{ id: string }>(
        `INSERT INTO sys.branches (code, name_ar, name_en) VALUES ('B2', 'فرع', 'Branch') RETURNING id`,
      );
      return rows[0]!.id;
    });
    await inContext(
      api,
      () => api.query(`UPDATE sys.branches SET name_en = 'Branch two' WHERE id = $1`, [branch]),
      tester,
    );
    const { rows } = await api.query<Record<string, string>>(
      'SELECT created_by::text, updated_by::text, row_version::text FROM sys.branches WHERE id = $1',
      [branch],
    );
    expect(rows[0]).toEqual({ created_by: '1', updated_by: tester.toString(), row_version: '2' });

    // The API may not touch the stamps at all …
    await api.query('BEGIN');
    await setContext(api);
    await expect(
      api.query('UPDATE sys.branches SET created_by = 2 WHERE id = $1', [branch]),
    ).rejects.toMatchObject({ code: '42501' });
    await api.query('ROLLBACK');

    // … and even the database owner cannot rewrite who created a record.
    const admin = await db.connect('superuser');
    await inContext(admin, () =>
      admin.query(`UPDATE sys.branches SET created_by = $2 WHERE id = $1`, [
        branch,
        tester.toString(),
      ]),
    );
    const after = await api.query<{ c: string }>(
      'SELECT created_by::text AS c FROM sys.branches WHERE id = $1',
      [branch],
    );
    expect(after.rows[0]!.c).toBe('1');
  });
});
