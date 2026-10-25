/**
 * Upgrading the server PC (decision 0103, M6.2 part G2). The server setup, run over an installed
 * server PC (by hand from a USB drive, or by the automatic updater of 0108), unpacks the new
 * programs beside the old ones (`C:\Program Files\ARTEPOOL.new`) and runs two phases through the
 * new launcher (`artepool-svc run upgrade prepare|apply`, as administrator):
 *
 *   prepare   (new programs, old folder still in place)
 *     1. checks   newer version; same PostgreSQL major version; the database answers
 *     2. stops    the server and backup services; refuses (and starts them again) if a shift is open
 *     3. backup   pg_dump into `backups\pre-upgrade\`, checked with pg_restore --list, SHA-256 beside
 *     4. stops    the database service, so the setup can swap the program folders
 *
 *   (the setup renames ARTEPOOL → ARTEPOOL.previous and ARTEPOOL.new → ARTEPOOL)
 *
 *   apply     (new programs, now in ARTEPOOL)
 *     5. services the WinSW files of the new version; the database service started
 *     6. migrate  every new migration in ONE transaction (all or nothing)
 *     7. ready    the server and backup services started; /health answers over TLS 1.3
 *
 * If 6 fails the database is unchanged. If 7 fails after migrations were applied, the database is
 * put back from the pre-upgrade backup (the upgraded one is kept aside, never deleted). Either way
 * every service is left stopped and the setup puts the previous program folder back and starts it.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import pg from 'pg';
import { createAppDatabase } from '@artepool/dev-db';
import { migrate } from '@artepool/migrate';
import { connectionArgs, pgTool, runPgTool as run, sha256File } from '@artepool/backup';
import type { PgConnection } from '@artepool/node-kit';
import type { InstallLog } from '../install/log';
import type { ServiceKey } from '../install/windows';

/** How many pre-upgrade copies stay in `backups\pre-upgrade` (the oldest beyond go). */
export const KEEP_PRE_UPGRADE = 10;

export type UpgradeStep =
  'checks' | 'open_shift' | 'backup' | 'services' | 'migrate' | 'health' | 'put_back';

export class UpgradeError extends Error {
  override readonly name = 'UpgradeError';
  constructor(
    readonly step: UpgradeStep,
    message: string,
  ) {
    super(message);
  }
}

/** The Windows services as the upgrade sees them; a fake one in the tests. */
export interface UpgradePlatform {
  startService(service: ServiceKey): Promise<void>;
  stopService(service: ServiceKey): Promise<void>;
  /** Writes the new version's WinSW files for an existing service (no new registration). */
  refreshAppService(service: 'server' | 'backup'): Promise<void>;
}

export interface UpgradeConnections {
  /** pg_dump (the backup role). */
  backup: PgConnection;
  /** The migrations and the audit entry (the migrator role). */
  migrator: PgConnection;
  /** Putting the database back from the pre-upgrade copy (create, rename): the superuser. */
  superuser: PgConnection;
}

/** 1.2.3 → [1, 2, 3]; anything else is refused. */
export function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) throw new UpgradeError('checks', `"${version}" is not a version (x.y.z).`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** `postgres (PostgreSQL) 18.1` → 18. */
export function postgresMajor(versionOutput: string): number | null {
  const match = /PostgreSQL\)?\s+(\d+)/.exec(versionOutput);
  return match ? Number(match[1]) : null;
}

/** `artepool-20261025-093000Z-1.4.0-to-1.5.0.dump` (UTC). */
export function preUpgradeFileName(from: string, to: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `artepool-${stamp}Z-${from}-to-${to}.dump`;
}

/** `artepool-20261025-093000Z-before-reinstall.dump` (UTC): the copy before a reinstall (G3). */
export function reinstallCopyName(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `artepool-${stamp}Z-before-reinstall.dump`;
}

const PRE_UPGRADE_COPY = /^artepool-\d{8}-\d{6}Z-.+\.dump$/;

async function openShifts(migrator: PgConnection, database: string): Promise<number> {
  const client = new pg.Client({ ...migrator, database, application_name: 'artepool-upgrade' });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cash.shifts WHERE status = 'open'`,
    );
    return rows[0]?.n ?? 0;
  } finally {
    await client.end();
  }
}

/** The oldest copies beyond KEEP_PRE_UPGRADE; never the one just made (even if the clock went back). */
async function removeOldPreUpgradeCopies(dir: string, current: string): Promise<void> {
  const copies = (await readdir(dir))
    .filter((n) => PRE_UPGRADE_COPY.test(n) && n !== current)
    .sort();
  copies.push(current);
  for (const name of copies.slice(0, Math.max(0, copies.length - KEEP_PRE_UPGRADE))) {
    await unlink(join(dir, name));
    await unlink(join(dir, `${name}.sha256`)).catch(() => undefined);
  }
}

export interface PrepareInput {
  from: string;
  to: string;
  /** The PostgreSQL major version of the database folder (`pgdata\PG_VERSION`). */
  dataPgMajor: number;
  /** The PostgreSQL major version the new programs bring. */
  bundledPgMajor: number | null;
  databaseName: string;
  backupsDir: string;
  pgBin: string;
  connections: UpgradeConnections;
  platform: UpgradePlatform;
  log: InstallLog;
  now?: Date;
}

export interface PreparedUpgrade {
  backup: string;
  sha256: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const SERVICES_IN_ORDER: ServiceKey[] = ['database', 'server', 'backup'];

async function startAll(platform: UpgradePlatform, log: InstallLog): Promise<void> {
  for (const service of SERVICES_IN_ORDER) {
    await platform.startService(service).catch((error: unknown) => {
      log.line(`Could not start ${service}: ${message(error)}`);
    });
  }
}

async function stopAll(platform: UpgradePlatform, log: InstallLog): Promise<void> {
  for (const service of [...SERVICES_IN_ORDER].reverse()) {
    await platform.stopService(service).catch((error: unknown) => {
      log.line(`Could not stop ${service}: ${message(error)}`);
    });
  }
}

/**
 * A copy of the whole database in `backups\pre-upgrade\<fileName>`, checked with pg_restore
 * --list, its SHA-256 beside it; the oldest copies beyond KEEP_PRE_UPGRADE go. Used before an
 * upgrade, and before a reinstall brings existing data up to its version (part G3).
 */
export async function preUpgradeCopy(input: {
  fileName: string;
  databaseName: string;
  backupsDir: string;
  pgBin: string;
  connection: PgConnection;
  log: InstallLog;
}): Promise<PreparedUpgrade> {
  const dir = join(input.backupsDir, 'pre-upgrade');
  await mkdir(dir, { recursive: true });
  const path = join(dir, input.fileName);
  const partial = `${path}.partial`;
  try {
    await run(
      pgTool(input.pgBin, 'pg_dump'),
      [
        ...connectionArgs(input.connection, input.databaseName),
        '--format=custom',
        '--compress=6',
        `--file=${partial}`,
      ],
      input.connection,
    );
    // A copy that pg_restore cannot list is not a backup.
    await run(pgTool(input.pgBin, 'pg_restore'), ['--list', partial], input.connection);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw new UpgradeError('backup', message(error));
  }
  await rename(partial, path);
  const sha256 = (await sha256File(path)).toString('hex');
  await writeFile(`${path}.sha256`, `${sha256}  ${basename(path)}\n`);
  const { size } = await stat(path);
  input.log.line(`Pre-upgrade backup: ${path} (${size} bytes, SHA-256 ${sha256})`);
  await removeOldPreUpgradeCopies(dir, basename(path));
  return { backup: path, sha256 };
}

export async function prepareUpgrade(input: PrepareInput): Promise<PreparedUpgrade> {
  const { platform, log, connections } = input;
  const now = input.now ?? new Date();

  log.line(`Upgrade ${input.from} → ${input.to}: checks`);
  if (compareVersions(input.to, input.from) <= 0) {
    throw new UpgradeError(
      'checks',
      `Version ${input.to} is not newer than the installed ${input.from}. Nothing was changed.`,
    );
  }
  if (input.bundledPgMajor !== null && input.bundledPgMajor !== input.dataPgMajor) {
    throw new UpgradeError(
      'checks',
      `The database is PostgreSQL ${input.dataPgMajor} and this version brings PostgreSQL ${input.bundledPgMajor}; this upgrade needs support. Nothing was changed.`,
    );
  }

  log.line('Stopping the server and backup services');
  await platform.stopService('backup');
  await platform.stopService('server');
  try {
    const open = await openShifts(connections.migrator, input.databaseName);
    if (open > 0) {
      throw new UpgradeError(
        'open_shift',
        `${open} shift(s) still open. The update waits until every shift is closed. Nothing was changed.`,
      );
    }

    log.line('Pre-upgrade backup');
    const { backup: path, sha256 } = await preUpgradeCopy({
      fileName: preUpgradeFileName(input.from, input.to, now),
      databaseName: input.databaseName,
      backupsDir: input.backupsDir,
      pgBin: input.pgBin,
      connection: connections.backup,
      log,
    });

    log.line('Stopping the database service');
    await platform.stopService('database');
    return { backup: path, sha256 };
  } catch (error) {
    await startAll(platform, log);
    throw error;
  }
}

export interface ApplyInput {
  from: string;
  to: string;
  /** The pre-upgrade copy made by `prepare`. */
  backup: string;
  databaseName: string;
  migrationsDir: string;
  pgBin: string;
  tlsCaFile: string;
  connections: UpgradeConnections;
  platform: UpgradePlatform;
  log: InstallLog;
  waitHealthy: (caPem: string) => Promise<void>;
  now?: Date;
}

export type UpgradeResult =
  | { ok: true; from: string; to: string; at: string; backup: string; migrations: number }
  | {
      ok: false;
      from: string;
      to: string;
      at: string;
      backup: string | null;
      step: UpgradeStep;
      detail: string;
      /** The database was put back from the pre-upgrade copy (only after migrations applied). */
      databasePutBack: boolean;
    };

async function recordEvent(
  migrator: PgConnection,
  database: string,
  event: 'system.upgraded' | 'system.upgrade_failed',
  detail: Record<string, unknown>,
): Promise<void> {
  const client = new pg.Client({ ...migrator, database, application_name: 'artepool-upgrade' });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE artepool_owner');
    await client.query(
      `SELECT sys.set_context(1, NULL, NULL, $1::uuid, NULL, NULL, 'server upgrade', NULL)`,
      [randomUUID()],
    );
    await client.query(`SELECT audit.record_event($1, 'sys.setup_state', '1', $2::jsonb)`, [
      event,
      JSON.stringify(detail),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

const stamp = (now: Date) => now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
const named = (base: string, suffix: string) => `${base.slice(0, 63 - suffix.length)}${suffix}`;

/**
 * The database back as it was before the upgrade: the pre-upgrade copy (its SHA-256 checked) is
 * restored into a new database, then the upgraded one is renamed aside (kept) and the restored one
 * takes its name. The live database is never left missing: a failed restore changes nothing.
 */
export async function putDatabaseBack(input: {
  backup: string;
  databaseName: string;
  pgBin: string;
  superuser: PgConnection;
  now: Date;
}): Promise<string> {
  const expected = (await readFile(`${input.backup}.sha256`, 'utf8')).split(/\s+/)[0];
  const actual = (await sha256File(input.backup)).toString('hex');
  if (expected !== actual) throw new Error('The pre-upgrade copy does not match its SHA-256.');

  const live = input.databaseName;
  const restoring = named(live, '_putback');
  const aside = named(live, `_failed_upgrade_${stamp(input.now)}`);
  const admin = new pg.Client({ ...input.superuser, database: 'postgres' });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(restoring)} WITH (FORCE)`);
    await createAppDatabase(admin, restoring);
    try {
      await run(
        pgTool(input.pgBin, 'pg_restore'),
        [
          ...connectionArgs(input.superuser, restoring),
          '--exit-on-error',
          '--single-transaction',
          input.backup,
        ],
        input.superuser,
      );
    } catch (error) {
      await admin.query(
        `DROP DATABASE IF EXISTS ${admin.escapeIdentifier(restoring)} WITH (FORCE)`,
      );
      throw error;
    }
    for (const database of [live, restoring]) {
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
      await admin.query(
        `ALTER DATABASE ${admin.escapeIdentifier(restoring)} RENAME TO ${admin.escapeIdentifier(live)}`,
      );
    } catch (error) {
      await admin.query(
        `ALTER DATABASE ${admin.escapeIdentifier(aside)} RENAME TO ${admin.escapeIdentifier(live)}`,
      );
      throw error;
    }
    // Kept for support, never deleted; nobody connects to it.
    await admin.query(
      `REVOKE CONNECT, TEMPORARY ON DATABASE ${admin.escapeIdentifier(aside)} FROM PUBLIC, artepool_migrator, artepool_api, artepool_backup, artepool_maint`,
    );
    return aside;
  } finally {
    await admin.end();
  }
}

export async function applyUpgrade(input: ApplyInput): Promise<UpgradeResult> {
  const { platform, log, connections } = input;
  const now = input.now ?? new Date();
  const base = { from: input.from, to: input.to, at: now.toISOString(), backup: input.backup };
  const fail = async (
    step: UpgradeStep,
    detail: string,
    databasePutBack: boolean,
  ): Promise<UpgradeResult> => {
    log.line(`FAILED (${step}): ${detail}`);
    await stopAll(platform, log);
    return { ok: false, ...base, step, detail, databasePutBack };
  };

  log.line(`Upgrade ${input.from} → ${input.to}: the services of the new version`);
  try {
    await platform.refreshAppService('server');
    await platform.refreshAppService('backup');
    await platform.startService('database');
  } catch (error) {
    return fail('services', message(error), false);
  }

  log.line('The database changes (all or nothing)');
  let applied: number;
  const client = new pg.Client({
    ...connections.migrator,
    database: input.databaseName,
    application_name: 'artepool-upgrade',
  });
  try {
    await client.connect();
    const files = await migrate({
      client,
      dir: input.migrationsDir,
      allOrNothing: true,
      log: (line) => log.line(line),
    });
    applied = files.length;
    log.line(`${applied} migration(s) applied.`);
  } catch (error) {
    await recordEvent(connections.migrator, input.databaseName, 'system.upgrade_failed', {
      from: input.from,
      to: input.to,
      step: 'migrate',
      backup: basename(input.backup),
    }).catch(() => undefined);
    return fail('migrate', `${message(error)} The database was not changed.`, false);
  } finally {
    await client.end().catch(() => undefined);
  }

  log.line('Starting the server and backup services');
  try {
    await platform.startService('server');
    await platform.startService('backup');
    await input.waitHealthy(await readFile(input.tlsCaFile, 'utf8'));
  } catch (error) {
    const detail = message(error);
    if (applied === 0) return fail('health', detail, false);
    log.line(`The new version does not answer (${detail}); putting the database back.`);
    await platform.stopService('backup').catch(() => undefined);
    await platform.stopService('server').catch(() => undefined);
    try {
      const aside = await putDatabaseBack({
        backup: input.backup,
        databaseName: input.databaseName,
        pgBin: input.pgBin,
        superuser: connections.superuser,
        now,
      });
      log.line(`The database is back as before the upgrade; the upgraded one is kept as ${aside}.`);
      await recordEvent(connections.migrator, input.databaseName, 'system.upgrade_failed', {
        from: input.from,
        to: input.to,
        step: 'health',
        backup: basename(input.backup),
      }).catch(() => undefined);
      return fail('health', detail, true);
    } catch (putBackError) {
      return fail(
        'put_back',
        `${detail}; the database could not be put back (${message(putBackError)}). The pre-upgrade copy is ${input.backup}.`,
        false,
      );
    }
  }

  await recordEvent(connections.migrator, input.databaseName, 'system.upgraded', {
    from: input.from,
    to: input.to,
    migrations: applied,
    backup: basename(input.backup),
  });
  log.line(`ARTEPOOL ${input.to} is running.`);
  return { ok: true, ...base, migrations: applied };
}
