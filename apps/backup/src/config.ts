/**
 * Where the backup service keeps its files and how many it keeps (decision 0086). On the
 * installed server the installer sets these; in development they come from `.env`.
 */
import { join } from 'node:path';
import {
  connectionFor,
  masterKeySource,
  repoRoot,
  type MasterKeySource,
  type PgConnection,
} from '@artepool/node-kit';

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
  masterKey: MasterKeySource;
  /** The sealed Google Drive credentials (client, refresh token) of the dedicated account. */
  driveCredentialsFile: string;
  /** Google's endpoints; replaced by a fake server in the tests. */
  google: GoogleEndpoints;
}

export interface GoogleEndpoints {
  /** The page where the person chooses the Google account (opened in the browser). */
  auth: string;
  oauth: string;
  api: string;
  upload: string;
}

export const GOOGLE: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  oauth: 'https://oauth2.googleapis.com',
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
};

/** The folders and files the API also needs (it never connects as the backup role). */
export interface BackupPaths {
  backupDir: string;
  masterKey: MasterKeySource;
  driveCredentialsFile: string;
  google: GoogleEndpoints;
  /**
   * The app's own registration at Google ("ARTEPOOL ERP", decision 0095), the same in every
   * installation and set by the installer: each shop then just chooses its own Google account.
   * Google treats these as not secret for desktop apps; they never give access to any account.
   */
  googleClients: GoogleClients;
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export interface GoogleClients {
  /** "Desktop app" client: the account is chosen in the browser. */
  desktop: GoogleClient | null;
  /** "TVs and limited input" client: the code typed at google.com/device (fallback). */
  device: GoogleClient | null;
}

const client = (id: string | undefined, secret: string | undefined): GoogleClient | null =>
  id && secret ? { clientId: id, clientSecret: secret } : null;

export function backupPaths(env: NodeJS.ProcessEnv = process.env): BackupPaths {
  return {
    backupDir: env.ARTEPOOL_BACKUP_DIR || join(repoRoot, '.backups'),
    masterKey: masterKeySource(env),
    driveCredentialsFile:
      env.ARTEPOOL_DRIVE_CREDENTIALS_FILE ||
      join(repoRoot, '.secrets', 'backup', 'google-drive.sealed'),
    google: GOOGLE,
    googleClients: {
      desktop: client(env.ARTEPOOL_GOOGLE_CLIENT_ID, env.ARTEPOOL_GOOGLE_CLIENT_SECRET),
      device: client(
        env.ARTEPOOL_GOOGLE_DEVICE_CLIENT_ID,
        env.ARTEPOOL_GOOGLE_DEVICE_CLIENT_SECRET,
      ),
    },
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
