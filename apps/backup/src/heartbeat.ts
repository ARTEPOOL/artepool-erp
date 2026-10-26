/**
 * The backup service's sign of life (M6.2 part H): it writes the time to `.heartbeat` in the
 * backups folder every minute, on its own timer, so a long copy or upload never makes it look
 * stopped. System health reads it; older than 5 minutes means the service is not running. A file
 * rather than a database row, so the audit log does not get a line every minute.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const HEARTBEAT_FILE = '.heartbeat';
export const HEARTBEAT_EVERY_MS = 60_000;
export const HEARTBEAT_STALE_MS = 5 * 60_000;

export async function writeHeartbeat(backupDir: string, now = new Date()): Promise<void> {
  await mkdir(backupDir, { recursive: true });
  await writeFile(join(backupDir, HEARTBEAT_FILE), `${now.toISOString()}\n`);
}

/** The last sign of life, or null when there is none (never started, or unreadable). */
export async function readHeartbeat(backupDir: string): Promise<Date | null> {
  try {
    const at = new Date((await readFile(join(backupDir, HEARTBEAT_FILE), 'utf8')).trim());
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

/** Writes the heartbeat now and every minute until the returned function is called. */
export function startHeartbeat(backupDir: string, onError: (error: unknown) => void): () => void {
  const beat = () => void writeHeartbeat(backupDir).catch(onError);
  beat();
  const timer = setInterval(beat, HEARTBEAT_EVERY_MS);
  return () => clearInterval(timer);
}
