/**
 * The weekly external-drive copy (decision 0086): with the drive plugged into the server PC, a
 * fresh local copy is written to `<drive>\ARTEPOOL-BACKUPS`, checked byte for byte, and the last 8
 * copies there are kept. The owner then unplugs the drive and keeps it locked away: a copy that
 * ransomware on the PC cannot reach. Not encrypted (owner's choice), so the drive itself must be
 * kept safe.
 */
import { copyFile, mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type pg from 'pg';
import type { BackupConfig } from './config';
import { localBackup } from './local';
import { failRun, finishRun, startRun } from './runs';
import { sha256File } from './tools';

export const OFFLINE_FOLDER = 'ARTEPOOL-BACKUPS';
const KEEP_ON_DRIVE = 8;

const README = `ARTEPOOL ERP — نسخ احتياطية / backups

هذه النسخ غير مشفّرة: احفظ هذا الهارد في مكان مقفول.
These copies are not encrypted: keep this drive locked away.

To restore, follow docs/runbooks/backup-and-restore.md.
`;

/** The folder must be an existing folder of its own, never the local backup folder itself. */
export async function checkDriveFolder(target: string, config: BackupConfig): Promise<string> {
  if (!isAbsolute(target)) throw new Error('The drive folder must be a full path such as E:\\');
  const folder = resolve(target);
  const inside = relative(resolve(config.backupDir), folder);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    throw new Error('The drive folder cannot be inside the local backup folder');
  }
  const info = await stat(folder).catch(() => null);
  if (!info?.isDirectory())
    throw new Error('The drive was not found: plug it in and check the letter');
  return folder;
}

export async function offlineCopy(
  client: pg.Client,
  config: BackupConfig,
  options: { target: string; requestId?: string | null },
): Promise<{ runId: string; path: string }> {
  const runId = await startRun(client, 'offline_copy', {
    requestId: options.requestId,
    target: options.target.slice(0, 300),
  });
  try {
    const drive = await checkDriveFolder(options.target, config);
    const folder = join(drive, OFFLINE_FOLDER);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'README.txt'), README);
    const copy = await localBackup(client, config);
    const path = join(folder, copy.fileName);
    await copyFile(copy.path, path);
    const [source, written] = await Promise.all([sha256File(copy.path), sha256File(path)]);
    if (!source.equals(written))
      throw new Error('The copy on the drive does not match: try another drive');
    const copies = (await readdir(folder))
      .filter((n) => /^artepool-\d{8}-\d{6}Z\.dump$/.test(n))
      .sort();
    const old = copies.slice(0, Math.max(0, copies.length - KEEP_ON_DRIVE));
    await Promise.all(old.map((n) => unlink(join(folder, n))));
    await finishRun(client, runId, {
      fileName: basename(path),
      sizeBytes: (await stat(path)).size,
      sha256: written,
      encrypted: false,
      details: { kept: Math.min(copies.length, KEEP_ON_DRIVE) },
    });
    return { runId, path };
  } catch (error) {
    await failRun(client, runId, error);
    throw error;
  }
}
