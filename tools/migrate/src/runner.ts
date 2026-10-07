import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client, DatabaseError } from 'pg';
import { MigrationError } from './errors';
import { loadMigrationFiles, type MigrationFile } from './files';

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrateOptions {
  /** A connected client logged in as artepool_migrator (a member of the owner role). */
  client: Client;
  dir: string;
  ownerRole?: string;
  /** Run every pending migration, then roll everything back. */
  dryRun?: boolean;
  log?: (message: string) => void;
}

const LOCK_KEY = 7_340_211_982; // advisory lock id reserved for the migration runner

const BOOTSTRAP = `
  CREATE SCHEMA IF NOT EXISTS sys;
  CREATE TABLE IF NOT EXISTS sys.schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    checksum_sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text NOT NULL,
    execution_ms integer NOT NULL
  );`;

async function readApplied(client: Client): Promise<AppliedMigration[]> {
  const exists = await client.query<{ t: string | null }>(
    `SELECT to_regclass('sys.schema_migrations') AS t`,
  );
  if (!exists.rows[0]?.t) return [];
  const { rows } = await client.query<{
    version: number;
    name: string;
    checksum_sha256: string;
    applied_at: Date;
  }>(
    'SELECT version, name, checksum_sha256, applied_at FROM sys.schema_migrations ORDER BY version',
  );
  return rows.map((r) => ({
    version: r.version,
    name: r.name,
    checksum: r.checksum_sha256,
    appliedAt: r.applied_at,
  }));
}

/** Applied migrations must be exactly the first files, unchanged. Returns the pending files. */
function verifyApplied(applied: AppliedMigration[], files: MigrationFile[]): MigrationFile[] {
  applied.forEach((row, index) => {
    const file = files[index];
    if (!file || file.version !== row.version) {
      throw new MigrationError(
        'MISSING_FILE',
        `Migration ${String(row.version).padStart(4, '0')}_${row.name} was applied to this database but its file is missing.`,
      );
    }
    if (file.name !== row.name || file.checksum !== row.checksum) {
      throw new MigrationError(
        'CHECKSUM_MISMATCH',
        `${file.fileName} was changed after it was applied. Applied migrations must never be edited — add a new migration instead.`,
      );
    }
  });
  return files.slice(applied.length);
}

function lineOf(sql: string, position: string | undefined): number | undefined {
  const offset = position ? Number.parseInt(position, 10) : NaN;
  return Number.isNaN(offset) ? undefined : sql.slice(0, offset).split('\n').length;
}

async function applyFile(client: Client, file: MigrationFile): Promise<number> {
  const started = performance.now();
  try {
    await client.query(file.sql);
  } catch (error) {
    const pgError = error as DatabaseError;
    const line = lineOf(file.sql, pgError.position);
    throw new MigrationError(
      'FAILED',
      `${file.fileName}${line ? ` (line ${line})` : ''}: ${pgError.message}`,
    );
  }
  const ms = Math.round(performance.now() - started);
  await client.query(
    `INSERT INTO sys.schema_migrations (version, name, checksum_sha256, applied_by, execution_ms)
     VALUES ($1, $2, $3, session_user, $4)`,
    [file.version, file.name, file.checksum, ms],
  );
  return ms;
}

async function withLock<T>(client: Client, work: () => Promise<T>): Promise<T> {
  const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
    LOCK_KEY,
  ]);
  if (!rows[0]?.ok) {
    throw new MigrationError(
      'ALREADY_RUNNING',
      'Another migration is already running on this database.',
    );
  }
  try {
    return await work();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}

/** Applies every pending migration, each in its own transaction, as the owner role. */
export async function migrate(options: MigrateOptions): Promise<MigrationFile[]> {
  const { client, dir, dryRun = false, log = () => undefined } = options;
  const ownerRole = client.escapeIdentifier(options.ownerRole ?? 'artepool_owner');
  const files = loadMigrationFiles(dir);

  return withLock(client, async () => {
    if (dryRun) {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL ROLE ${ownerRole}`);
        await client.query(BOOTSTRAP);
        const pending = verifyApplied(await readApplied(client), files);
        for (const file of pending) {
          const ms = await applyFile(client, file);
          log(`Checked ${file.fileName} (${ms} ms)`);
        }
        return pending;
      } finally {
        await client.query('ROLLBACK');
      }
    }

    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL ROLE ${ownerRole}`);
      await client.query(BOOTSTRAP);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    const pending = verifyApplied(await readApplied(client), files);
    for (const file of pending) {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL ROLE ${ownerRole}`);
        await client.query(`SET LOCAL lock_timeout = '10s'`);
        const ms = await applyFile(client, file);
        await client.query('COMMIT');
        log(`Applied ${file.fileName} (${ms} ms)`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return pending;
  });
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: MigrationFile[];
}

export async function migrationStatus(client: Client, dir: string): Promise<MigrationStatus> {
  const files = loadMigrationFiles(dir);
  const applied = await readApplied(client);
  return { applied, pending: verifyApplied(applied, files) };
}

/** Creates the next numbered migration file and returns its path. */
export function createMigrationFile(dir: string, name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new MigrationError('BAD_FILE_NAME', 'Use lower_snake_case for migration names.');
  }
  const next = loadMigrationFiles(dir).length + 1;
  const fileName = `${String(next).padStart(4, '0')}_${name}.sql`;
  const path = join(dir, fileName);
  writeFileSync(
    path,
    `-- ${fileName}\n-- Purpose: \n-- Never edit this file after it has been applied anywhere. Add a new migration instead.\n\n`,
    { flag: 'wx' },
  );
  return path;
}
