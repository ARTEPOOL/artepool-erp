/**
 * The daily off-site copy (decision 0086): the newest local copy, with the server's master key
 * (decision 0102, see bundle.ts), is encrypted with the owner's age public key, then uploaded to
 * the dedicated Google Drive account. Google only ever holds the encrypted file; only the owner's
 * offline private key opens it. Older off-site copies beyond 30 daily + 12 monthly go to the
 * Drive trash.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { Encrypter } from 'age-encryption';
import type pg from 'pg';
import { SecretBox } from '@artepool/node-kit';
import { encryptBundle } from './bundle';
import type { BackupConfig } from './config';
import { Drive, loadDriveCredentials } from './google';
import { latestLocalCopy, localBackup } from './local';
import { filesToRemove } from './retention';
import { failRun, finishRun, startRun } from './runs';

export class OffsiteNotReady extends Error {
  override readonly name = 'OffsiteNotReady';
  constructor(readonly reason: 'no_key' | 'drive_not_connected') {
    super(
      reason === 'no_key'
        ? 'No backup key yet (System health → Create backup key)'
        : 'Google Drive is not connected yet',
    );
  }
}

export async function ageRecipient(client: pg.Client): Promise<string | null> {
  const { rows } = await client.query<{ value: unknown }>(
    `SELECT value FROM sys.settings WHERE key = 'backup.age_recipient'`,
  );
  const value = rows[0]?.value;
  return typeof value === 'string' ? value : null;
}

/** Encrypts a file for the age recipient (streamed, so large copies fit in memory). */
export async function encryptFile(path: string, recipient: string): Promise<Buffer> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const plain = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
  const sealed = await encrypter.encrypt(plain);
  return buffer(sealed);
}

export async function offsiteUpload(
  client: pg.Client,
  config: BackupConfig,
  options: { requestId?: string | null; now?: Date } = {},
): Promise<{ runId: string; fileName: string }> {
  const runId = await startRun(client, 'offsite_upload', {
    requestId: options.requestId,
    target: 'google_drive',
  });
  try {
    const recipient = await ageRecipient(client);
    if (!recipient) throw new OffsiteNotReady('no_key');
    const box = await SecretBox.fromSource(config.masterKey);
    const credentials = await loadDriveCredentials(config.driveCredentialsFile, box);
    if (!credentials) throw new OffsiteNotReady('drive_not_connected');
    const copy = (await latestLocalCopy(config)) ?? (await localBackup(client, config)).path;
    const sealed = await encryptBundle(
      await readFile(copy),
      basename(copy),
      await SecretBox.keyForBackup(config.masterKey),
      recipient,
    );
    const fileName = `${basename(copy)}.age`;
    const drive = await Drive.open(config.google, credentials);
    const uploaded = await drive.upload(fileName, sealed);
    const files = await drive.list();
    const old = new Set(
      filesToRemove(
        files.map((f) => f.name),
        options.now ?? new Date(),
        config.offsiteKeep,
      ),
    );
    for (const file of files) if (old.has(file.name)) await drive.trash(file.id);
    await finishRun(client, runId, {
      fileName,
      sizeBytes: sealed.length,
      sha256: createHash('sha256').update(sealed).digest(),
      encrypted: true,
      details: { driveFileId: uploaded.id, source: basename(copy), trashed: old.size },
    });
    return { runId, fileName };
  } catch (error) {
    await failRun(client, runId, error);
    throw error;
  }
}
