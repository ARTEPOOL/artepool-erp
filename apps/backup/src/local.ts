/**
 * The hourly local copy (decision 0086): pg_dump of the whole database (custom format) into the
 * backup folder, checked to be readable, its fingerprint and the audit chain head recorded; then
 * the old copies are removed (48 hourly + 30 daily).
 */
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { BackupConfig } from './config';
import { inSystemTx } from './db';
import { backupFileName, filesToRemove } from './retention';
import { failRun, finishRun, startRun } from './runs';
import { connectionArgs, pgTool, run, sha256File } from './tools';

export interface LocalCopy {
  runId: string;
  path: string;
  fileName: string;
}

export async function localBackup(
  client: pg.Client,
  config: BackupConfig,
  options: { requestId?: string | null; now?: Date } = {},
): Promise<LocalCopy> {
  const runId = await startRun(client, 'logical_dump', {
    requestId: options.requestId,
    target: config.backupDir,
  });
  try {
    await mkdir(config.backupDir, { recursive: true });
    const fileName = backupFileName(options.now ?? new Date());
    const path = join(config.backupDir, fileName);
    const partial = `${path}.partial`;
    // The chain head is anchored first, so the copy holds the anchor it is checked against.
    const anchor = await inSystemTx(client, `backup anchor: ${fileName}`, async () => {
      const { rows } = await client.query<{ chain_seq: string; chain_hash: Buffer }>(
        `SELECT chain_seq::text, chain_hash FROM audit.add_anchor('backup', $1)`,
        [fileName],
      );
      return rows[0]!;
    });
    await run(
      pgTool(config.pgBin, 'pg_dump'),
      [
        ...connectionArgs(config.connection),
        '--format=custom',
        '--compress=6',
        `--file=${partial}`,
      ],
      config.connection,
    );
    // A copy that pg_restore cannot list is not a backup.
    await run(pgTool(config.pgBin, 'pg_restore'), ['--list', partial], config.connection);
    await rename(partial, path);
    const [size, sha256] = await Promise.all([stat(path), sha256File(path)]);
    await finishRun(client, runId, {
      fileName,
      sizeBytes: size.size,
      sha256,
      chainSeq: anchor.chain_seq,
      chainHash: anchor.chain_hash,
    });
    await removeOldCopies(config, options.now ?? new Date());
    return { runId, path, fileName };
  } catch (error) {
    await failRun(client, runId, error);
    throw error;
  }
}

export async function removeOldCopies(config: BackupConfig, now: Date): Promise<string[]> {
  const names = await readdir(config.backupDir);
  const old = filesToRemove(names, now, config.keep);
  await Promise.all(old.map((name) => unlink(join(config.backupDir, name))));
  return old;
}

/** The newest local copy in the folder, if any. */
export async function latestLocalCopy(config: BackupConfig): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(config.backupDir);
  } catch {
    return null;
  }
  const copies = names.filter((n) => /^artepool-\d{8}-\d{6}Z\.dump$/.test(n)).sort();
  const last = copies.at(-1);
  return last ? join(config.backupDir, last) : null;
}
