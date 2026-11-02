/**
 * Whether Google still accepts the saved Google Drive access (decision 0095): checked at every
 * off-site upload and, between them, every 6 hours (a token request only, nothing is uploaded).
 * Two refusals are told apart, because the fix differs:
 * - `access_ended`: Google ended the saved access (`invalid_grant`): the registration was left in
 *   "Testing" (7 days), the access was removed from the Google account, or the account is gone.
 *   The owner connects Google Drive again.
 * - `registration_refused`: Google refused the app's registration itself (the client was deleted,
 *   disabled or its secret changed). The publisher makes a new client; the next update brings it.
 * A network failure is neither: the last answer stays, and the late copy is reported as late.
 * The answer is kept in a small file in the backups folder, like the heartbeat, so the audit log
 * does not get a line every 6 hours; System health reads it.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SecretBox } from '@artepool/node-kit';
import type { BackupConfig } from './config';
import { Drive, GoogleError, loadDriveCredentials, type DriveCredentials } from './google';

export const DRIVE_ACCESS_FILE = '.drive-access';
export const DRIVE_CHECK_EVERY_MS = 6 * 3600 * 1000;

export type DriveAccessProblem = 'access_ended' | 'registration_refused';

export interface DriveAccessState {
  checkedAt: string;
  problem: DriveAccessProblem | null;
  /** Google's error code (`invalid_grant`, `deleted_client`, …); never a token. */
  code: string | null;
}

const REGISTRATION_CODES = new Set([
  'invalid_client',
  'unauthorized_client',
  'deleted_client',
  'disabled_client',
]);

/** Which refusal Google's answer is, or null when it is not a refusal (a network failure). */
export function driveAccessProblem(error: unknown): DriveAccessProblem | null {
  if (!(error instanceof GoogleError) || !error.code) return null;
  if (error.code === 'invalid_grant') return 'access_ended';
  if (REGISTRATION_CODES.has(error.code)) return 'registration_refused';
  return null;
}

export async function writeDriveAccess(backupDir: string, state: DriveAccessState): Promise<void> {
  await mkdir(backupDir, { recursive: true });
  const file = join(backupDir, DRIVE_ACCESS_FILE);
  await writeFile(`${file}.partial`, `${JSON.stringify(state)}\n`);
  await rename(`${file}.partial`, file);
}

/** The last answer, or null when there is none or it cannot be read. */
export async function readDriveAccess(backupDir: string): Promise<DriveAccessState | null> {
  try {
    const value = JSON.parse(await readFile(join(backupDir, DRIVE_ACCESS_FILE), 'utf8')) as {
      checkedAt?: unknown;
      problem?: unknown;
      code?: unknown;
    };
    const problem =
      value.problem === 'access_ended' || value.problem === 'registration_refused'
        ? value.problem
        : null;
    if (typeof value.checkedAt !== 'string' || Number.isNaN(Date.parse(value.checkedAt))) {
      return null;
    }
    return {
      checkedAt: value.checkedAt,
      problem,
      code: typeof value.code === 'string' ? value.code.slice(0, 60) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Opens Google Drive with the saved access and records Google's answer: accepted, or which
 * refusal. A network failure records nothing. Throws what Drive.open threw.
 */
export async function openDrive(
  config: BackupConfig,
  credentials: DriveCredentials,
  now = new Date(),
): Promise<Drive> {
  try {
    const drive = await Drive.open(config.google, credentials);
    await writeDriveAccess(config.backupDir, {
      checkedAt: now.toISOString(),
      problem: null,
      code: null,
    });
    return drive;
  } catch (error) {
    const problem = driveAccessProblem(error);
    if (problem) {
      await writeDriveAccess(config.backupDir, {
        checkedAt: now.toISOString(),
        problem,
        code: (error as GoogleError).code,
      });
    }
    throw error;
  }
}

/**
 * Due when Google Drive is connected and the last answer is older than 6 hours, or older than the
 * saved access (the owner just connected again).
 */
export async function driveCheckDue(config: BackupConfig, now = new Date()): Promise<boolean> {
  const connected = await stat(config.driveCredentialsFile).catch(() => null);
  if (!connected) return false;
  const last = await readDriveAccess(config.backupDir);
  if (!last) return true;
  const checkedAt = Date.parse(last.checkedAt);
  return now.getTime() - checkedAt >= DRIVE_CHECK_EVERY_MS || connected.mtime.getTime() > checkedAt;
}

/** The check between uploads: asks Google for access with the saved one, nothing more. */
export async function checkDriveAccess(
  config: BackupConfig,
  now = new Date(),
): Promise<DriveAccessState | null> {
  const box = await SecretBox.fromSource(config.masterKey);
  const credentials = await loadDriveCredentials(config.driveCredentialsFile, box);
  if (!credentials) return null;
  await openDrive(config, credentials, now);
  return readDriveAccess(config.backupDir);
}
