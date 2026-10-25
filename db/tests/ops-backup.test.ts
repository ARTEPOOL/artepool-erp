/**
 * Migration 0036: backups (decision 0086). Only the owner asks for a backup; the backup service
 * records its runs as the SYSTEM user, moves them forward only, and can never change business
 * data; finished runs are final; the key setting holds only an age public key.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, createUser, inContext, type TestDatabase } from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;
let backup: pg.Client;
let owner: bigint;
let accountant: bigint;

type Row = Record<string, string | number | null>;
const asApi = (sql: string, params: unknown[], userId: bigint) =>
  inContext(api, () => api.query<Row>(sql, params), userId);
const asBackup = (sql: string, params: unknown[] = []) =>
  inContext(backup, () => backup.query<Row>(sql, params), 1n);

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  backup = await db.connect('backup');
  owner = await createUser(api, {
    username: 'owner.main',
    signInMethod: 'password_totp',
    roles: ['owner'],
  });
  accountant = await createUser(api, { username: 'khaled.acc', roles: ['accountant'] });
});
afterAll(() => db.drop());

describe('backup requests', () => {
  it('only the owner asks, one open request per kind; the service moves it forward only', async () => {
    await expect(
      asApi(`INSERT INTO ops.backup_requests (kind) VALUES ('restore_test')`, [], accountant),
    ).rejects.toMatchObject({ code: 'AP010' });
    const { rows } = await asApi(
      `INSERT INTO ops.backup_requests (kind) VALUES ('restore_test') RETURNING id`,
      [],
      owner,
    );
    const id = String(rows[0]!.id);
    await expect(
      asApi(`INSERT INTO ops.backup_requests (kind) VALUES ('restore_test')`, [], owner),
    ).rejects.toMatchObject({ code: '23505' });
    // The drive copy needs its folder, the others never have one.
    await expect(
      asApi(`INSERT INTO ops.backup_requests (kind) VALUES ('offline_copy')`, [], owner),
    ).rejects.toMatchObject({ code: '23514' });
    // The API cannot change a request; the backup service moves it forward only.
    await expect(
      asApi(`UPDATE ops.backup_requests SET status = 'done' WHERE id = $1`, [id], owner),
    ).rejects.toMatchObject({ code: '42501' });
    await asBackup(`UPDATE ops.backup_requests SET status = 'running' WHERE id = $1`, [id]);
    await expect(
      asBackup(`UPDATE ops.backup_requests SET status = 'pending' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: 'AP003' });
    await asBackup(`UPDATE ops.backup_requests SET status = 'done' WHERE id = $1`, [id]);
    await expect(
      asBackup(
        `UPDATE ops.backup_requests SET status = 'failed', error_message = 'x' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: 'AP003' });
  });
});

describe('backup runs', () => {
  it('are written by the backup service, final once finished, never deleted', async () => {
    const { rows } = await asBackup(
      `INSERT INTO ops.backup_runs (kind, target) VALUES ('logical_dump', 'local') RETURNING id, created_by`,
    );
    const run = rows[0]!;
    expect(run.created_by).toBe('1');
    await expect(
      asBackup(`UPDATE ops.backup_runs SET status = 'failed', finished_at = now() WHERE id = $1`, [
        run.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' }); // a failure needs its message
    await asBackup(
      `UPDATE ops.backup_runs SET status = 'success', finished_at = now(), size_bytes = 10 WHERE id = $1`,
      [run.id],
    );
    await expect(
      asBackup(`UPDATE ops.backup_runs SET size_bytes = 11 WHERE id = $1`, [run.id]),
    ).rejects.toMatchObject({ code: 'AP003' });
    await expect(
      asBackup(`DELETE FROM ops.backup_runs WHERE id = $1`, [run.id]),
    ).rejects.toMatchObject({ code: '42501' });
    // Audited like every write.
    const audit = await api.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.log WHERE entity_type = 'ops.backup_runs'`,
    );
    expect(audit.rows[0]!.n).toBe(2);
  });

  it('the backup service reads everything but can never change business data', async () => {
    await expect(asBackup(`SELECT count(*) FROM sales.documents`)).resolves.toBeDefined();
    await expect(
      asBackup(`UPDATE sys.settings SET value = '5' WHERE key = 'security.max_failed_logins'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asBackup(`INSERT INTO ops.backup_requests (kind) VALUES ('backup_now')`),
    ).rejects.toMatchObject({
      code: '42501',
    });
    await expect(asBackup(`SELECT * FROM audit.verify_chain()`)).resolves.toBeDefined();
  });
});

describe('the encryption key setting', () => {
  it('holds only an age public key (or nothing)', async () => {
    const set = (value: string) =>
      asApi(
        `UPDATE sys.settings SET value = $1::jsonb WHERE key = 'backup.age_recipient'`,
        [value],
        owner,
      );
    await expect(set('"AGE-SECRET-KEY-1ABC"')).rejects.toMatchObject({ code: '23514' });
    await expect(set('"age1short"')).rejects.toMatchObject({ code: '23514' });
    await set(`"age1${'q'.repeat(58)}"`);
    await set('null');
  });
});
