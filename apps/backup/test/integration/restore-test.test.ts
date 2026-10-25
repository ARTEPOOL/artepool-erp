/**
 * The restore test and the integrity checks (decision 0086) against a real PostgreSQL: the newest
 * copy restores into a throwaway database, every check passes there, the result is recorded and
 * the throwaway database is gone; on the live database the checks catch a changed audit entry
 * and a numbering gap.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@artepool/testing';
import { configFromEnv, type BackupConfig } from '../../src/config';
import { connect } from '../../src/db';
import { nightlyIntegrity, runChecks } from '../../src/integrity';
import { localBackup } from '../../src/local';
import { dropThrowaway, restoreDatabaseName, restoreTest } from '../../src/restore';

let db: TestDatabase;
let client: pg.Client;
let admin: pg.Client;
let dir: string;
let config: BackupConfig;

beforeAll(async () => {
  db = await createTestDatabase();
  admin = await db.connect('superuser');
  dir = await mkdtemp(join(tmpdir(), 'artepool-restore-'));
  config = { ...configFromEnv(db.name), backupDir: dir };
  client = await connect(config.connection);
});
afterAll(async () => {
  await client.end();
  await rm(dir, { recursive: true, force: true });
  await db.drop();
});

/** Changes rows behind the database's back, as an attacker with full access would. */
async function tamper(statement: string): Promise<void> {
  await admin.query('BEGIN');
  await admin.query('SET LOCAL session_replication_role = replica');
  await admin.query(statement);
  await admin.query('COMMIT');
}

describe('the restore test', () => {
  it('restores the newest copy, finds no problem, records it and removes the copy database', async () => {
    const copy = await localBackup(client, config);
    const result = await restoreTest(client, config);
    expect(result.ok).toBe(true);
    expect(result.fileName).toBe(copy.fileName);
    expect(Object.keys(result.results).sort()).toEqual([
      'audit_chain',
      'journals_balanced',
      'numbering_gaps',
      'stock_vs_ledger',
      'trial_balance',
    ]);
    const run = await client.query<{ status: string; target: string }>(
      `SELECT status, target FROM ops.backup_runs WHERE id = $1`,
      [result.runId],
    );
    expect(run.rows[0]).toEqual({ status: 'success', target: restoreDatabaseName(db.name) });
    const integrity = await client.query<{ status: string; run_kind: string }>(
      `SELECT status, run_kind FROM ops.integrity_runs WHERE backup_run_id = $1`,
      [result.runId],
    );
    expect(integrity.rows[0]).toEqual({ status: 'ok', run_kind: 'restore_test' });
    const left = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
      restoreDatabaseName(db.name),
    ]);
    expect(left.rowCount).toBe(0);
  });
});

describe('the integrity checks on the live database', () => {
  it('pass on a healthy database and record the nightly run', async () => {
    expect(Object.values(await runChecks(client)).every((r) => r.ok)).toBe(true);
    const run = await nightlyIntegrity(client);
    expect(run.status).toBe('ok');
  });

  it('catch a numbering gap and a changed audit entry', async () => {
    await tamper(`UPDATE sys.document_series SET next_number = next_number + 1 WHERE code = 'POS'`);
    await tamper(
      `UPDATE audit.log SET reason = 'changed later' WHERE id = (SELECT min(id) FROM audit.log)`,
    );
    const results = await runChecks(client);
    expect(results.numbering_gaps).toMatchObject({ ok: false, problems: 1 });
    expect(results.numbering_gaps!.examples[0]).toMatch(/^POS: /);
    expect(results.audit_chain!.ok).toBe(false);
    const run = await nightlyIntegrity(client);
    expect(run.status).toBe('issues');
  });
});

describe('removing the throwaway database', () => {
  const exists = async (name: string) =>
    (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1;

  it('drops it plainly, ending its own sessions first when one is still connected', async () => {
    const backup = new pg.Client({ ...config.connection, database: 'postgres' });
    await backup.connect();
    try {
      const name = restoreDatabaseName(`${db.name}_drop`);
      await backup.query(`CREATE DATABASE ${backup.escapeIdentifier(name)} TEMPLATE template0`);
      await dropThrowaway(backup, name);
      expect(await exists(name)).toBe(false);

      // Still connected (its own role): that session is ended, then the plain DROP runs.
      await backup.query(`CREATE DATABASE ${backup.escapeIdentifier(name)} TEMPLATE template0`);
      const inside = new pg.Client({ ...config.connection, database: name });
      inside.on('error', () => undefined);
      await inside.connect();
      await dropThrowaway(backup, name);
      expect(await exists(name)).toBe(false);
      await inside.end().catch(() => undefined);

      // Nothing there: nothing to do.
      await dropThrowaway(backup, name);
    } finally {
      await backup.end();
    }
  });
});
