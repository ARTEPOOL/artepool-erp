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
  /** Off-site: the first copy of each of the last `daily` days and `monthly` months. */
  offsiteKeep: { hourly: number; daily: number; monthly: number };
  /** The master key that seals the Google Drive credentials (never in the database). */
  masterKeyFile: string;
  /** The sealed Google Drive credentials (client, refresh token) of the dedicated account. */
  driveCredentialsFile: string;
  /** Google's endpoints; replaced by a fake server in the tests. */
  google: GoogleEndpoints;
}

export interface GoogleEndpoints {
  oauth: string;
  api: string;
  upload: string;
}

export const GOOGLE: GoogleEndpoints = {
  oauth: 'https://oauth2.googleapis.com',
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
};

/** The folders and files the API also needs (it never connects as the backup role). */
export interface BackupPaths {
  backupDir: string;
  masterKeyFile: string;
  driveCredentialsFile: string;
  google: GoogleEndpoints;
}

export function backupPaths(env: NodeJS.ProcessEnv = process.env): BackupPaths {
  return {
    backupDir: env.ARTEPOOL_BACKUP_DIR || join(repoRoot, '.backups'),
    masterKeyFile: env.ARTEPOOL_MASTER_KEY_FILE || join(repoRoot, '.secrets', 'master.key'),
    driveCredentialsFile:
      env.ARTEPOOL_DRIVE_CREDENTIALS_FILE ||
      join(repoRoot, '.secrets', 'backup', 'google-drive.sealed'),
    google: GOOGLE,
  };
}

export function configFromEnv(database?: string): BackupConfig {
  return {
    ...backupPaths(),
    pgBin: process.env.ARTEPOOL_PG_BIN ?? '',
    connection: connectionFor('backup', database),
    keep: { hourly: 48, daily: 30 },
    offsiteKeep: { hourly: 0, daily: 30, monthly: 12 },
  };
}
