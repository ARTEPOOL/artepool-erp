/**
 * The restore program (decision 0102, M6.2 part E2) on a real PostgreSQL: an off-site copy of an
 * old server restored on a "new server PC". The master key goes back (development: the key file,
 * the old one kept beside it), the wizard's token is removed, this PC gets an enrollment code on
 * the restored data, a fresh copy and its restore test pass; the progress is reported step by step.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv, connect, encryptBundle, localBackup } from '@artepool/backup';
import { connectionFor } from '@artepool/node-kit';
import {
  createDevice,
  createTestDatabase,
  createUser,
  inContext,
  type TestDatabase,
} from '@artepool/testing';
import {
  developmentHooks,
  restoreFromBackup,
  type RestoreMessage,
} from '../../src/cli/restore-from-backup';

let dir: string;
let oldServer: TestDatabase;
let live: TestDatabase;
let sealed: Buffer;
let identity: string;
const masterKey = randomBytes(32);
const now = new Date('2026-10-24T09:30:00Z');
const savedBackupDir = process.env.ARTEPOOL_BACKUP_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artepool-restore-program-'));
  process.env.ARTEPOOL_BACKUP_DIR = join(dir, 'backups');
  identity = await generateX25519Identity();
  oldServer = await createTestDatabase();
  const su = await oldServer.connect('superuser');
  await createUser(su, { username: 'mohammed', signInMethod: 'password_totp', roles: ['owner'] });
  await createDevice(su, { code: 'COUNTER-01', kind: 'pos' });
  await inContext(su, async () => {
    await su.query(`UPDATE sys.setup_state SET state = 'in_progress', path = 'new'`);
    await su.query(`UPDATE sys.setup_state SET state = 'complete'`);
  });
  // The old server's own copies folder, not the new server's.
  const config = { ...configFromEnv(oldServer.name), backupDir: join(dir, 'old') };
  const client = await connect(config.connection);
  const copy = await localBackup(client, config);
  await client.end();
  sealed = await encryptBundle(
    await readFile(copy.path),
    copy.fileName,
    masterKey,
    await identityToRecipient(identity),
  );
  live = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await oldServer.drop();
  await live.drop();
  const admin = new pg.Client({ ...connectionFor('superuser'), database: 'postgres' });
  await admin.connect();
  await admin.query(
    `DROP DATABASE IF EXISTS ${admin.escapeIdentifier(`${live.name}_before_restore_20261024093000`)} WITH (FORCE)`,
  );
  await admin.end();
  if (savedBackupDir === undefined) delete process.env.ARTEPOOL_BACKUP_DIR;
  else process.env.ARTEPOOL_BACKUP_DIR = savedBackupDir;
  await rm(dir, { recursive: true, force: true });
});

describe('the restore program', () => {
  it('restores, puts the master key back, enrolls this PC and makes a checked copy', async () => {
    const keyFile = join(dir, 'master.key');
    const oldKey = randomBytes(32).toString('base64');
    await writeFile(keyFile, oldKey, { mode: 0o600 });
    const tokenFile = join(dir, 'token');
    await writeFile(tokenFile, 'setup-token');
    const messages: RestoreMessage[] = [];

    const result = await restoreFromBackup({
      copy: sealed,
      privateKey: `${identity}\n`,
      report: (message) => messages.push(message),
      liveDatabase: live.name,
      hooks: developmentHooks(keyFile, now),
      setupTokenFile: tokenFile,
      now,
    });

    expect(result).toMatchObject({
      ok: true,
      masterKeyRestored: true,
      revokedDevices: 1,
      backup: { ok: true },
    });
    expect(messages.map((m) => ('step' in m ? m.step : 'result'))).toEqual([
      'opening',
      'restoring',
      'upgrading',
      'checking',
      'replacing',
      'enrolling',
      'backing_up',
    ]);
    // The copy's master key is in use; the new installation's key is kept beside it.
    expect(await readFile(keyFile, 'utf8')).toBe(masterKey.toString('base64'));
    expect(await readFile(`${keyFile}.before-restore-20261024093000`, 'utf8')).toBe(oldKey);
    // The wizard is locked.
    expect(existsSync(tokenFile)).toBe(false);
    // This PC's enrollment code, on the restored data, from the restore.
    if (!result.ok) throw new Error('restore failed');
    expect(result.enrollment?.code).toMatch(/\S{6,}/);
    const su = new pg.Client({ ...connectionFor('superuser'), database: live.name });
    await su.connect();
    try {
      const { rows } = await su.query<{ origin: string; open: boolean }>(
        `SELECT origin, used_at IS NULL AND cancelled_at IS NULL AS open FROM auth.enrollment_codes`,
      );
      expect(rows).toEqual([{ origin: 'console', open: true }]);
      const reasons = await su.query<{ reason: string }>(
        `SELECT DISTINCT reason FROM audit.log WHERE entity_type = 'auth.enrollment_codes'`,
      );
      expect(reasons.rows).toEqual([
        { reason: 'restore from backup: enrollment code for the new server PC' },
      ]);
    } finally {
      await su.end();
    }
    // The fresh copy lies in the backups folder; the restore's temporary file does not.
    const files = await readdir(join(dir, 'backups'));
    expect(files.filter((f) => f.endsWith('.dump'))).toHaveLength(1);
    expect(files.some((f) => f.startsWith('restore-'))).toBe(false);
  });
});
