/**
 * The daily off-site copy (decision 0086) against a real PostgreSQL and a fake Google: refused
 * without a key or a connected Drive (recorded); encrypted before upload so only the private key
 * opens it; old copies go to the Drive trash; the device sign-in waits for the owner's approval.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '@artepool/node-kit';
import { createTestDatabase, inContext, type TestDatabase } from '@artepool/testing';
import { configFromEnv, type BackupConfig } from '../../src/config';
import { connect } from '../../src/db';
import {
  finishDeviceSignIn,
  loadDriveCredentials,
  saveDriveCredentials,
  startDeviceSignIn,
} from '../../src/google';
import { latestLocalCopy, localBackup } from '../../src/local';
import { offsiteUpload } from '../../src/offsite';
import { backupFileName } from '../../src/retention';
import { startFakeGoogle, type FakeGoogle } from '../support/fake-google';

let db: TestDatabase;
let client: pg.Client;
let api: pg.Client;
let dir: string;
let config: BackupConfig;
let google: FakeGoogle;
let box: SecretBox;
let identity: string;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  dir = await mkdtemp(join(tmpdir(), 'artepool-offsite-'));
  google = await startFakeGoogle();
  const masterKeyFile = join(dir, 'master.key');
  await writeFile(masterKeyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
  box = await SecretBox.fromFile(masterKeyFile);
  config = {
    ...configFromEnv(db.name),
    backupDir: join(dir, 'copies'),
    masterKeyFile,
    driveCredentialsFile: join(dir, 'secrets', 'google-drive.sealed'),
    google: google.endpoints,
  };
  client = await connect(config.connection);
  identity = await generateX25519Identity();
});
afterAll(async () => {
  await client.end();
  await google.close();
  await rm(dir, { recursive: true, force: true });
  await db.drop();
});

const lastRun = async () =>
  (
    await client.query<{
      status: string;
      error_message: string | null;
      encrypted: boolean;
      file_name: string;
    }>(
      `SELECT status, error_message, encrypted, file_name FROM ops.backup_runs
        WHERE kind = 'offsite_upload' ORDER BY id DESC LIMIT 1`,
    )
  ).rows[0]!;

describe('the off-site copy', () => {
  it('is refused, and recorded, without a key or without Google Drive', async () => {
    await expect(offsiteUpload(client, config)).rejects.toThrow(/No backup key/);
    expect(await lastRun()).toMatchObject({ status: 'failed' });
    const recipient = await identityToRecipient(identity);
    await inContext(api, () =>
      api.query(
        `UPDATE sys.settings SET value = to_jsonb($1::text) WHERE key = 'backup.age_recipient'`,
        [recipient],
      ),
    );
    await expect(offsiteUpload(client, config)).rejects.toThrow(/not connected/);
  });

  it('connects Google Drive with the device code, keeping the token sealed', async () => {
    const code = await startDeviceSignIn(google.endpoints, 'client-1');
    expect(code).toMatchObject({
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://www.google.com/device',
    });
    const client1 = { clientId: 'client-1', clientSecret: 'secret-1' };
    expect(await finishDeviceSignIn(google.endpoints, client1, code.deviceCode)).toBeNull();
    google.approve();
    const refreshToken = await finishDeviceSignIn(google.endpoints, client1, code.deviceCode);
    expect(refreshToken).toBe('refresh-xyz');
    await saveDriveCredentials(config.driveCredentialsFile, box, {
      ...client1,
      refreshToken: refreshToken!,
      connectedAt: new Date().toISOString(),
    });
    const onDisk = await readFile(config.driveCredentialsFile, 'utf8');
    expect(onDisk).not.toContain('refresh-xyz');
    expect((await loadDriveCredentials(config.driveCredentialsFile, box))?.refreshToken).toBe(
      'refresh-xyz',
    );
  });

  it('uploads the newest copy encrypted: only the private key opens it', async () => {
    const copy = await localBackup(client, config);
    // Two old copies on Drive: one beyond 30 days and 12 months, one from yesterday.
    const old = `${backupFileName(new Date(Date.now() - 400 * 24 * 3600 * 1000))}.age`;
    const recent = `${backupFileName(new Date(Date.now() - 24 * 3600 * 1000))}.age`;
    google.files.push(
      { id: 'old', name: old, body: Buffer.from('x'), trashed: false },
      { id: 'recent', name: recent, body: Buffer.from('x'), trashed: false },
    );
    const result = await offsiteUpload(client, config);
    expect(result.fileName).toBe(`${copy.fileName}.age`);
    expect(await lastRun()).toMatchObject({
      status: 'success',
      encrypted: true,
      file_name: result.fileName,
    });
    const uploaded = google.files.find((f) => f.name === result.fileName)!;
    const plain = await readFile((await latestLocalCopy(config))!);
    expect(uploaded.body.includes(plain.subarray(0, 64))).toBe(false);
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    expect(Buffer.from(await decrypter.decrypt(new Uint8Array(uploaded.body))).equals(plain)).toBe(
      true,
    );
    // Another key cannot open it.
    const stranger = new Decrypter();
    stranger.addIdentity(await generateX25519Identity());
    await expect(stranger.decrypt(new Uint8Array(uploaded.body))).rejects.toThrow();
    // Retention: the very old copy went to the trash, yesterday's stays.
    expect(google.files.find((f) => f.id === 'old')!.trashed).toBe(true);
    expect(google.files.find((f) => f.id === 'recent')!.trashed).toBe(false);
  });
});
