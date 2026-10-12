/** Meta-checks: every table follows the safety rules, so a new table cannot silently skip them. */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@artepool/testing';

const APP_SCHEMAS = ['sys', 'auth', 'audit', 'md', 'inv', 'sales', 'cash', 'gl', 'ops'];
/** Tables with their own protection instead of the generic audit trigger. */
const NOT_ROW_AUDITED = [
  'sys.schema_migrations',
  'audit.log',
  'audit.chain_head',
  'audit.anchors',
  'audit.verifications',
  // Technical tables (docs/database-schema.md §4.7, §5.6–5.7): sign-in, sign-out and lock are
  // explicit audit events instead.
  'auth.device_activity',
  'auth.sessions',
  'sys.idempotency_keys',
  // Derived: written only by the movement trigger, checked against the movements (schema §8.2).
  'inv.balances',
];
/** Link and technical tables the API may delete from (docs/database-schema.md §2). */
const API_MAY_DELETE = ['auth.role_permissions', 'auth.user_roles', 'md.bundle_components'];

let db: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  admin = await db.connect('superuser');
});
afterAll(() => db.drop());

async function tables(): Promise<string[]> {
  const { rows } = await admin.query<{ t: string }>(
    `SELECT schemaname || '.' || tablename AS t FROM pg_tables WHERE schemaname = ANY ($1) ORDER BY 1`,
    [APP_SCHEMAS],
  );
  return rows.map((r) => r.t);
}

async function triggersOf(table: string): Promise<string[]> {
  const { rows } = await admin.query<{ tgname: string }>(
    'SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal',
    [table],
  );
  return rows.map((r) => r.tgname);
}

describe('every table follows the safety rules', () => {
  it('is owned by artepool_owner', async () => {
    const { rows } = await admin.query<{ t: string }>(
      `SELECT schemaname || '.' || tablename AS t FROM pg_tables
        WHERE schemaname = ANY ($1) AND tableowner <> 'artepool_owner'`,
      [APP_SCHEMAS],
    );
    expect(rows).toEqual([]);
  });

  it('is audited', async () => {
    const missing: string[] = [];
    for (const table of await tables()) {
      if (!NOT_ROW_AUDITED.includes(table) && !(await triggersOf(table)).includes('z_audit')) {
        missing.push(table);
      }
    }
    expect(missing).toEqual([]);
  });

  it('cannot be truncated, and business records cannot be deleted', async () => {
    const problems: string[] = [];
    for (const table of await tables()) {
      if (table === 'sys.schema_migrations') continue;
      const triggers = await triggersOf(table);
      const hasTruncateGuard = triggers.some((t) => t.includes('truncate'));
      const hasDeleteGuard = triggers.some((t) =>
        ['guard_no_delete', 'guard_log', 'guard_head'].includes(t),
      );
      if (!hasTruncateGuard) problems.push(`${table}: no truncate guard`);
      if (!hasDeleteGuard && !API_MAY_DELETE.includes(table))
        problems.push(`${table}: no delete guard`);
    }
    expect(problems).toEqual([]);
  });

  it('the API may delete only from the allowed link tables, and never truncate', async () => {
    const { rows } = await admin.query<{ t: string; del: boolean; trunc: boolean }>(
      `SELECT schemaname || '.' || tablename AS t,
              has_table_privilege('artepool_api', format('%I.%I', schemaname, tablename), 'DELETE') AS del,
              has_table_privilege('artepool_api', format('%I.%I', schemaname, tablename), 'TRUNCATE') AS trunc
         FROM pg_tables WHERE schemaname = ANY ($1)`,
      [APP_SCHEMAS],
    );
    expect(
      rows
        .filter((r) => r.del)
        .map((r) => r.t)
        .sort(),
    ).toEqual(API_MAY_DELETE);
    expect(rows.filter((r) => r.trunc)).toEqual([]);
  });

  it('no function can be run by everyone, and privileged functions pin their search path', async () => {
    const { rows: open } = await admin.query<{ f: string }>(
      `SELECT p.oid::regprocedure::text AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ANY ($1) AND has_function_privilege('artepool_maint', p.oid, 'EXECUTE')`,
      [APP_SCHEMAS],
    );
    expect(open).toEqual([]);
    const { rows: definers } = await admin.query<{ f: string }>(
      `SELECT p.oid::regprocedure::text AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ANY ($1) AND p.prosecdef
          AND NOT coalesce(p.proconfig, '{}') @> ARRAY['search_path=pg_catalog, pg_temp']`,
      [APP_SCHEMAS],
    );
    expect(definers).toEqual([]);
  });
});
