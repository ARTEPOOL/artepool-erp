/**
 * Restore from backup on a new server PC (decision 0102, M6.2 part E) against a real PostgreSQL:
 * the old server's copy (with its master key, encrypted for the owner's key) replaces the new
 * server's empty database only when every check passes; a wrong key, a changed copy or an
 * installation already in use change nothing; the old server's PCs are revoked so they enroll
 * again; the empty database is kept aside; the master key goes back to the protected store.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@artepool/migrate';
import { connectionFor, migrationsDir } from '@artepool/node-kit';
import {
  createDevice,
  createTestDatabase,
  createUser,
  inContext,
  type TestDatabase,
} from '@artepool/testing';
import { encryptBundle } from '../../src/bundle';
import { configFromEnv, type BackupConfig } from '../../src/config';
import { connect } from '../../src/db';
import { fullRestore, type RestoreHooks } from '../../src/full-restore';
import { localBackup } from '../../src/local';

let oldServer: TestDatabase;
let dir: string;
let config: BackupConfig;
let identity: string;
let recipient: string;
let dump: Buffer;
let dumpName: string;
const masterKey = randomBytes(32);
/** Throwaway databases (closed and dropped after), and the empty ones kept aside by a restore. */
const servers: TestDatabase[] = [];
const extraDatabases: string[] = [];

const superuser = () => connectionFor('superuser');

async function admin(): Promise<pg.Client> {
  const client = new pg.Client({ ...superuser(), database: 'postgres' });
  await client.connect();
  return client;
}

async function exists(name: string): Promise<boolean> {
  const client = await admin();
  try {
    return (
      (await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1
    );
  } finally {
    await client.end();
  }
}

async function query<T extends pg.QueryResultRow>(database: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ ...superuser(), database });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

/** Hooks that record what happened, as the Windows services and the launcher would. */
function hooks(): RestoreHooks & { calls: string[]; savedKey: Buffer | null } {
  const record = {
    calls: [] as string[],
    savedKey: null as Buffer | null,
    stopServices: () => Promise.resolve(void record.calls.push('stop')),
    startServices: () => Promise.resolve(void record.calls.push('start')),
    saveMasterKey: (key: Buffer) => {
      record.calls.push('save-key');
      record.savedKey = key;
      return Promise.resolve();
    },
    upgrade: async (client: pg.Client) => {
      record.calls.push('upgrade');
      await migrate({ client, dir: migrationsDir });
    },
    progress: (step: string) => void record.calls.push(`step:${step}`),
  };
  return record;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artepool-full-restore-'));
  identity = await generateX25519Identity();
  recipient = await identityToRecipient(identity);
  // The old server: an owner, two PCs, the company, and a copy of it all.
  oldServer = await createTestDatabase();
  const su = await oldServer.connect('superuser');
  await createUser(su, { username: 'mohammed', signInMethod: 'password_totp', roles: ['owner'] });
  await createDevice(su, { code: 'COUNTER-01', kind: 'pos' });
  await createDevice(su, { code: 'OFFICE-01', kind: 'office' });
  await inContext(su, () =>
    su.query(`INSERT INTO sys.company_profile (id, legal_name_ar, legal_name_en, vat_registered,
                address_ar, address_en) VALUES (1, 'آرتيبول', 'ARTEPOOL OLD', false, 'العين', 'Al Ain')`),
  );
  await finishSetup(oldServer);
  config = { ...configFromEnv(oldServer.name), backupDir: dir };
  ({ dump, fileName: dumpName } = await copyOf(oldServer));
}, 120_000);

afterAll(async () => {
  for (const db of servers) await db.drop();
  const client = await admin();
  try {
    for (const name of extraDatabases) {
      await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`);
    }
  } finally {
    await client.end();
  }
  await oldServer.drop();
  await rm(dir, { recursive: true, force: true });
});

/** The first-run wizard finished (an owner exists). */
async function finishSetup(db: TestDatabase): Promise<void> {
  const su = await db.connect('superuser');
  await inContext(su, async () => {
    await su.query(`UPDATE sys.setup_state SET state = 'in_progress', path = 'new'`);
    await su.query(`UPDATE sys.setup_state SET state = 'complete'`);
  });
}

/** A copy of a database, as the backup service makes it. */
async function copyOf(db: TestDatabase): Promise<{ dump: Buffer; fileName: string }> {
  const copyConfig = { ...configFromEnv(db.name), backupDir: dir };
  const client = await connect(copyConfig.connection);
  try {
    const copy = await localBackup(client, copyConfig);
    return { dump: await readFile(copy.path), fileName: copy.fileName };
  } finally {
    await client.end();
  }
}

/** A new server PC just installed: an empty database, setup not started. */
async function newServer(): Promise<TestDatabase> {
  const db = await createTestDatabase();
  servers.push(db);
  return db;
}

const run = (live: string, copy: Buffer, key: string | null, h: ReturnType<typeof hooks>) =>
  fullRestore({
    copy,
    privateKey: key,
    superuser: superuser(),
    liveDatabase: live,
    pgBin: config.pgBin,
    workDir: dir,
    hooks: h,
    now: new Date('2026-10-24T08:00:00Z'),
  });

describe('restore from backup', () => {
  it('a wrong key changes nothing', async () => {
    const live = await newServer();
    const sealed = await encryptBundle(dump, dumpName, masterKey, recipient);
    const h = hooks();
    const result = await run(live.name, sealed, await generateX25519Identity(), h);
    expect(result).toEqual({ ok: false, reason: 'wrong_key' });
    expect(h.calls).toEqual(['step:opening']);
    expect(await exists(`${live.name}_restoring`)).toBe(false);
  });

  it('a copy whose audit log was changed fails the checks: nothing replaced, nothing left', async () => {
    const live = await newServer();
    // The same data, with one audit entry changed behind the database's back.
    const changed = await createTestDatabase();
    servers.push(changed);
    const su = await changed.connect('superuser');
    await inContext(su, () =>
      su.query(`INSERT INTO sys.company_profile (id, legal_name_ar, legal_name_en, vat_registered,
                  address_ar, address_en) VALUES (1, 'أ', 'A', false, 'ع', 'A')`),
    );
    await su.query('BEGIN');
    await su.query('SET LOCAL session_replication_role = replica');
    await su.query(
      `UPDATE audit.log SET reason = 'changed' WHERE id = (SELECT max(id) FROM audit.log WHERE row_hash IS NOT NULL)`,
    );
    await su.query('COMMIT');
    const copy = await copyOf(changed);
    const sealed = await encryptBundle(copy.dump, copy.fileName, masterKey, recipient);

    const h = hooks();
    const result = await run(live.name, sealed, identity, h);
    expect(result).toMatchObject({ ok: false, reason: 'checks_failed' });
    expect(result.ok === false && result.results?.audit_chain?.ok).toBe(false);
    expect(h.calls).not.toContain('stop');
    expect(await exists(`${live.name}_restoring`)).toBe(false);
    expect(await query(live.name, 'SELECT 1 FROM sys.company_profile')).toEqual([]);
  });

  it('refuses on an installation already in use', async () => {
    const live = await newServer();
    await finishSetup(live);
    const result = await run(live.name, dump, null, hooks());
    expect(result).toEqual({ ok: false, reason: 'setup_done' });
  });

  it('refuses a copy of an installation that was never set up (no owner to sign in with)', async () => {
    const live = await newServer();
    const copy = await copyOf(await newServer());
    const h = hooks();
    const result = await run(live.name, copy.dump, null, h);
    expect(result).toMatchObject({ ok: false, reason: 'not_set_up' });
    expect(h.calls).not.toContain('stop');
    expect(await exists(`${live.name}_restoring`)).toBe(false);
  });

  it('replaces the empty database when every check passes; the master key goes back', async () => {
    const live = await newServer();
    const sealed = await encryptBundle(dump, dumpName, masterKey, recipient);
    const h = hooks();
    const result = await run(live.name, sealed, identity, h);
    expect(result).toMatchObject({
      ok: true,
      dumpName,
      masterKeyRestored: true,
      revokedDevices: 2,
      devicesWithOpenShifts: [],
      replacedDatabase: `${live.name}_before_restore_20261024080000`,
    });
    extraDatabases.push(`${live.name}_before_restore_20261024080000`);
    expect(h.calls).toEqual([
      'step:opening',
      'step:restoring',
      'step:upgrading',
      'upgrade',
      'step:checking',
      'step:replacing',
      'stop',
      'save-key',
      'start',
    ]);
    expect(h.savedKey!.equals(masterKey)).toBe(true);

    // The live name now holds the old server's data, with its owners and permissions.
    expect(await query(live.name, 'SELECT legal_name_en FROM sys.company_profile')).toEqual([
      { legal_name_en: 'ARTEPOOL OLD' },
    ]);
    const api = new pg.Client({ ...connectionFor('api', live.name) });
    await api.connect();
    expect(
      (await api.query('SELECT username FROM auth.users WHERE username = $1', ['mohammed'])).rows,
    ).toHaveLength(1);
    await api.end();
    // The old PCs must enroll again; the restore is in the audit log.
    expect(
      await query(live.name, `SELECT code, status, revoke_reason FROM auth.devices ORDER BY code`),
    ).toEqual([
      {
        code: 'COUNTER-01',
        status: 'revoked',
        revoke_reason: 'Restored on a new server PC: enroll this PC again',
      },
      {
        code: 'OFFICE-01',
        status: 'revoked',
        revoke_reason: 'Restored on a new server PC: enroll this PC again',
      },
    ]);
    expect(
      await query(
        live.name,
        `SELECT action, reason FROM audit.log WHERE action = 'event:system.restored_from_backup'`,
      ),
    ).toEqual([{ action: 'event:system.restored_from_backup', reason: 'restore from backup' }]);
    expect(await query(live.name, 'SELECT bool_and(ok) AS ok FROM audit.verify_chain()')).toEqual([
      { ok: true },
    ]);
    // The empty database is kept aside, out of use.
    expect(await exists(`${live.name}_before_restore_20261024080000`)).toBe(true);
    expect(await exists(`${live.name}_restoring`)).toBe(false);
  });

  it('a plain copy (the external drive) restores without a master key', async () => {
    const live = await newServer();
    const h = hooks();
    const result = await run(live.name, dump, null, h);
    expect(result).toMatchObject({ ok: true, masterKeyRestored: false, dumpName: null });
    extraDatabases.push(`${live.name}_before_restore_20261024080000`);
    expect(h.calls).not.toContain('save-key');
  });
});
