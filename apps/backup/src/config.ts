/**
 * Where the backup service keeps its files and how many it keeps (decision 0086). On the
 * installed server the installer sets these; in development they come from `.env`.
 */
import { join } from 'node:path';
import { connectionFor, repoRoot, type PgConnection } from '@artepool/node-kit';

export interface BackupConfig {
  /** The folder for the local copies (a second disk when there is one). */
  backupDir: string;
  /** The folder holding pg_dump / pg_restore; empty = found on the PATH. */
  pgBin: string;
  /** The live database, as the backup role (reads everything, changes nothing). */
  connection: PgConnection;
  /** Every copy of the last `hourly` hours, and the first copy of each of the last `daily` days. */
  keep: { hourly: number; daily: number };
}

export function configFromEnv(database?: string): BackupConfig {
  return {
    backupDir: process.env.ARTEPOOL_BACKUP_DIR || join(repoRoot, '.backups'),
    pgBin: process.env.ARTEPOOL_PG_BIN ?? '',
    connection: connectionFor('backup', database),
    keep: { hourly: 48, daily: 30 },
  };
}
