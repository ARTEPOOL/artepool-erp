/**
 * Migration 0045 (M6.2 part H): the server PC's health row. Only the owner confirms the UPS; the
 * API cannot touch the certificate columns and the updater (backup role) cannot confirm the UPS;
 * every change, a certificate renewal included, is in the audit log with its old and new values;
 * the row is never deleted.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, createUser, setContext, type TestDatabase } from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;
let backup: pg.Client;
let su: pg.Client;
let owner: bigint;
let accountant: bigint;

beforeAll(async () => {
  db = await createTestDatabase();
  su = await db.connect('superuser');
  api = await db.connect('api');
  backup = await db.connect('backup');
  owner = await createUser(su, {
    username: 'owner',
    signInMethod: 'password_totp',
    roles: ['owner'],
  });
  accountant = await createUser(su, { username: 'acc', roles: ['accountant'] });
});
afterAll(async () => {
  await Promise.all([api.end(), backup.end(), su.end()]);
  await db.drop();
});

/** Runs `sql` as `client` for `user`; the refusal's message, or null. */
async function attempt(
  client: pg.Client,
  user: bigint,
  sql: string,
  params: unknown[] = [],
): Promise<string | null> {
  await client.query('BEGIN');
  try {
    await setContext(client, user, 'test');
    await client.query(sql, params);
    await client.query('COMMIT');
    return null;
  } catch (error) {
    await client.query('ROLLBACK');
    return (error as Error).message;
  }
}

describe('the server health row', () => {
  it('exists once, empty', async () => {
    const { rows } = await su.query('SELECT * FROM ops.server_health');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ups_confirmed_at: null, cert_expires_at: null });
  });

  it('lets only the owner confirm the UPS, through the API', async () => {
    const confirm = 'UPDATE ops.server_health SET ups_confirmed_at = now() WHERE id = 1';
    expect(await attempt(api, accountant, confirm)).toMatch(/Only the owner confirms the UPS/);
    expect(await attempt(api, owner, confirm)).toBeNull();
    expect(await attempt(backup, 1n, confirm)).toMatch(/permission denied/);
  });

  it('lets only the updater record the certificate, and audits old and new expiry', async () => {
    expect(
      await attempt(
        api,
        owner,
        `UPDATE ops.server_health SET cert_expires_at = now() WHERE id = 1`,
      ),
    ).toMatch(/permission denied/);
    const first = '2027-01-01T00:00:00Z';
    const renewed = '2028-12-01T00:00:00Z';
    expect(
      await attempt(backup, 1n, `UPDATE ops.server_health SET cert_expires_at = $1 WHERE id = 1`, [
        first,
      ]),
    ).toBeNull();
    expect(
      await attempt(
        backup,
        1n,
        `UPDATE ops.server_health SET cert_expires_at = $1, cert_renewed_at = now(),
                cert_renew_attempted_at = now(), cert_renew_error = NULL WHERE id = 1`,
        [renewed],
      ),
    ).toBeNull();
    const { rows } = await su.query<{ old: string; new: string }>(
      `SELECT old_values ->> 'cert_expires_at' AS old, new_values ->> 'cert_expires_at' AS new
         FROM audit.log WHERE entity_type = 'ops.server_health' AND action = 'update'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(new Date(rows[0]!.old).toISOString()).toBe(new Date(first).toISOString());
    expect(new Date(rows[0]!.new).toISOString()).toBe(new Date(renewed).toISOString());
  });

  it('is never deleted', async () => {
    expect(await attempt(su, owner, 'DELETE FROM ops.server_health')).not.toBeNull();
  });

  it('accepts the new alerts', async () => {
    for (const type of [
      'ups_unconfirmed',
      'disk_low',
      'disk_urgent',
      'service_down',
      'wal_archive_failed',
      'certificate_expiring',
      'certificate_renewal_failed',
      'root_ca_expiring',
    ]) {
      expect(
        await attempt(
          su,
          1n,
          `INSERT INTO sys.alerts (alert_type, severity, params, dedupe_key)
           VALUES ($1, 'warning', '{}', $1 || ':test')`,
          [type],
        ),
        type,
      ).toBeNull();
    }
  });
});
