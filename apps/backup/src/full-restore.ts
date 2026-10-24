/**
 * Restore from backup on a new server PC (decision 0102, M6.2 part E). Run by the first-run
 * wizard, through the launcher as a Windows administrator, on a fresh installation only:
 *
 *   1. open the copy (the owner's private key opens an encrypted one; bundle.ts);
 *   2. restore it into a separate database, owners and permissions kept;
 *   3. bring it up to this program's version (the migrations, all or nothing);
 *   4. run every integrity check: the audit chain (with the copy's anchor), journals balanced,
 *      trial balance, stock against the ledger, numbering; and the copy must come from an
 *      installation whose setup was finished (it has its owner);
 *   5. only if every check passes: the old server's PCs are revoked ("enroll again": this server
 *      has a new certificate authority) and the restore is recorded in the audit log;
 *   6. the services stop, the empty new database is renamed aside (kept, never deleted), the
 *      restored one takes its name, the master key goes back into the protected store, and the
 *      services start again.
 *
 * Any failure before step 6 leaves the live database untouched and removes the separate one.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { ROLES, type PgConnection } from '@artepool/node-kit';
import { BundleError, openCopy } from './bundle';
import { allOk, runChecks, type CheckResults } from './integrity';
import { connectionArgs, pgTool, run } from './tools';

export type RestoreStep = 'opening' | 'restoring' | 'upgrading' | 'checking' | 'replacing';

export type RestoreFailure =
  | 'setup_done'
  | 'wrong_key'
  | 'not_a_copy'
  | 'damaged'
  | 'restore_failed'
  | 'newer_copy'
  | 'checks_failed'
  | 'not_set_up'
  | 'replace_failed';

export interface RestoreHooks {
  /** Stops the API and backup services (Windows), so nothing holds the databases open. */
  stopServices(): Promise<void>;
  startServices(): Promise<void>;
  /** Puts the copy's master key into the protected store (DPAPI through the launcher). */
  saveMasterKey(key: Buffer): Promise<void>;
  /** Brings the restored database up to this program's version (the migration runner). */
  upgrade(client: pg.Client): Promise<void>;
  progress(step: RestoreStep): void;
}

export interface FullRestoreInput {
  copy: Buffer;
  /** `AGE-SECRET-KEY-1…`, or null for a plain copy (the external drive's). */
  privateKey: string | null;
  /** The PostgreSQL superuser (only the restore uses it; it is never given to the services). */
  superuser: PgConnection;
  /** The live database's name (e.g. `artepool`). */
  liveDatabase: string;
  pgBin: string;
  /** Where the database copy is written while pg_restore reads it (deleted afterwards). */
  workDir: string;
  hooks: RestoreHooks;
  now?: Date;
}

export type FullRestoreResult =
  | {
      ok: true;
      dumpName: string | null;
      masterKeyRestored: boolean;
      results: CheckResults;
      /** The empty database the restored one replaced, kept under this name. */
      replacedDatabase: string;
      /** PCs of the old server, revoked so they enroll again; those still kept, and why. */
      revokedDevices: number;
      devicesWithOpenShifts: string[];
    }
  | { ok: false; reason: RestoreFailure; results?: CheckResults; detail?: string };

/** A database name of at most 63 bytes with this ending. */
const named = (base: string, suffix: string) => `${base.slice(0, 63 - suffix.length)}${suffix}`;

const stamp = (now: Date) => now.toISOString().replace(/[-:T]/g, '').slice(0, 14);

async function connect(connection: PgConnection, database: string): Promise<pg.Client> {
  const client = new pg.Client({
    ...connection,
    database,
    application_name: 'artepool-restore',
  });
  await client.connect();
  return client;
}

async function setupDone(superuser: PgConnection, live: string): Promise<boolean> {
  const client = await connect(superuser, live);
  try {
    const { rows } = await client.query<{ state: string }>('SELECT state FROM sys.setup_state');
    return rows[0]?.state === 'complete';
  } finally {
    await client.end();
  }
}

async function dropDatabase(admin: pg.Client, name: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
}

/** The restored database's PCs belong to the old server: revoked so they enroll again. */
async function retireOldDevices(
  client: pg.Client,
  detail: { dumpName: string | null; masterKeyRestored: boolean },
): Promise<{ revoked: number; kept: string[] }> {
  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT sys.set_context(1, NULL, NULL, $1::uuid, NULL, NULL, 'restore from backup', NULL)`,
      [randomUUID()],
    );
    // A PC with an open shift stays until the shift is closed (decision 0069).
    const { rows: kept } = await client.query<{ code: string }>(
      `SELECT d.code FROM auth.devices d
        WHERE d.status = 'active' AND EXISTS (
          SELECT 1 FROM cash.shifts s JOIN cash.registers r ON r.id = s.register_id
           WHERE r.device_id = d.id AND s.status = 'open')
        ORDER BY d.code`,
    );
    const revoked = await client.query(
      `UPDATE auth.devices d SET status = 'revoked',
              revoke_reason = 'Restored on a new server PC: enroll this PC again'
        WHERE d.status = 'active' AND NOT EXISTS (
          SELECT 1 FROM cash.shifts s JOIN cash.registers r ON r.id = s.register_id
           WHERE r.device_id = d.id AND s.status = 'open')`,
    );
    await client.query(
      `SELECT audit.record_event('system.restored_from_backup', 'sys.setup_state', '1', $1::jsonb)`,
      [
        JSON.stringify({
          copy: detail.dumpName,
          masterKeyRestored: detail.masterKeyRestored,
          revokedDevices: revoked.rowCount ?? 0,
          devicesWithOpenShifts: kept.map((k) => k.code),
        }),
      ],
    );
    await client.query('COMMIT');
    return { revoked: revoked.rowCount ?? 0, kept: kept.map((k) => k.code) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function fullRestore(input: FullRestoreInput): Promise<FullRestoreResult> {
  const { superuser, liveDatabase: live, hooks } = input;
  const now = input.now ?? new Date();
  const target = named(live, '_restoring');
  const aside = named(live, `_before_restore_${stamp(now)}`);

  // Only a fresh installation: an installation already in use is never replaced from here.
  if (await setupDone(superuser, live)) return { ok: false, reason: 'setup_done' };

  hooks.progress('opening');
  let opened;
  try {
    opened = await openCopy(input.copy, input.privateKey);
  } catch (error) {
    if (error instanceof BundleError) return { ok: false, reason: error.reason };
    throw error;
  }

  const admin = await connect(superuser, 'postgres');
  const dumpFile = join(input.workDir, `restore-${stamp(now)}-${randomUUID().slice(0, 8)}.dump`);
  let keepTarget = false;
  try {
    await dropDatabase(admin, target);
    const name = admin.escapeIdentifier(target);
    await admin.query(
      `CREATE DATABASE ${name} OWNER ${ROLES.owner} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'`,
    );
    // Nobody connects to it before the checks pass.
    await admin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${name} FROM PUBLIC`);

    hooks.progress('restoring');
    await mkdir(input.workDir, { recursive: true });
    await writeFile(dumpFile, opened.dump, { mode: 0o600 });
    try {
      // As the superuser, owners and permissions are kept exactly as on the old server.
      await run(
        pgTool(input.pgBin, 'pg_restore'),
        [...connectionArgs(superuser, target), '--exit-on-error', '--single-transaction', dumpFile],
        superuser,
      );
    } catch (error) {
      return {
        ok: false,
        reason: 'restore_failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await unlink(dumpFile).catch(() => undefined);
    }

    const restored = await connect(superuser, target);
    let results: CheckResults;
    let devices: { revoked: number; kept: string[] };
    try {
      hooks.progress('upgrading');
      try {
        await hooks.upgrade(restored);
      } catch (error) {
        return {
          ok: false,
          reason: 'newer_copy',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      hooks.progress('checking');
      results = await runChecks(restored);
      if (!allOk(results)) return { ok: false, reason: 'checks_failed', results };
      // A copy of an installation that was never set up has no owner to sign in with.
      const setup = await restored.query<{ state: string }>('SELECT state FROM sys.setup_state');
      if (setup.rows[0]?.state !== 'complete') return { ok: false, reason: 'not_set_up', results };
      devices = await retireOldDevices(restored, {
        dumpName: opened.dumpName,
        masterKeyRestored: opened.masterKey !== null,
      });
    } finally {
      await restored.end();
    }

    hooks.progress('replacing');
    await hooks.stopServices();
    keepTarget = true;
    try {
      for (const database of [live, target]) {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database],
        );
      }
      await admin.query(
        `ALTER DATABASE ${admin.escapeIdentifier(live)} RENAME TO ${admin.escapeIdentifier(aside)}`,
      );
      try {
        await admin.query(`ALTER DATABASE ${name} RENAME TO ${admin.escapeIdentifier(live)}`);
      } catch (error) {
        // Put the empty database back under its name: the installation stays as it was.
        await admin.query(
          `ALTER DATABASE ${admin.escapeIdentifier(aside)} RENAME TO ${admin.escapeIdentifier(live)}`,
        );
        keepTarget = false;
        throw error;
      }
      const restoredLive = admin.escapeIdentifier(live);
      await admin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${restoredLive} FROM PUBLIC`);
      await admin.query(
        `GRANT CONNECT ON DATABASE ${restoredLive} TO ${ROLES.migrator}, ${ROLES.api}, ${ROLES.backup}, ${ROLES.maint}`,
      );
      // The empty database stays (never deleted), but nobody uses it any more.
      await admin.query(
        `REVOKE CONNECT, TEMPORARY ON DATABASE ${admin.escapeIdentifier(aside)} FROM PUBLIC, ${ROLES.migrator}, ${ROLES.api}, ${ROLES.backup}, ${ROLES.maint}`,
      );
      if (opened.masterKey) await hooks.saveMasterKey(opened.masterKey);
    } catch (error) {
      await hooks.startServices().catch(() => undefined);
      return {
        ok: false,
        reason: 'replace_failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    await hooks.startServices();
    return {
      ok: true,
      dumpName: opened.dumpName,
      masterKeyRestored: opened.masterKey !== null,
      results,
      replacedDatabase: aside,
      revokedDevices: devices.revoked,
      devicesWithOpenShifts: devices.kept,
    };
  } finally {
    if (!keepTarget) await dropDatabase(admin, target).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}
