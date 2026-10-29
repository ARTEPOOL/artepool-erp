/**
 * The external-drive copy and the service's schedule (decision 0086) against a real PostgreSQL:
 * the drive folder is checked, a verified copy lands in ARTEPOOL-BACKUPS (8 kept); the schedule
 * makes the hourly copy and the nightly check once, and carries out the owner's requests.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, createUser, inContext, type TestDatabase } from '@artepool/testing';
import { configFromEnv, type BackupConfig } from '../../src/config';
import { connect } from '../../src/db';
import { OFFLINE_FOLDER, offlineCopy } from '../../src/offline';
import { backupFileName } from '../../src/retention';
import { tick } from '../../src/service';

let db: TestDatabase;
let client: pg.Client;
let api: pg.Client;
let dir: string;
let drive: string;
let config: BackupConfig;
let owner: bigint;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  owner = await createUser(api, {
    username: 'owner.main',
    signInMethod: 'password_totp',
    roles: ['owner'],
  });
  dir = await mkdtemp(join(tmpdir(), 'artepool-offline-'));
  drive = join(dir, 'E-drive');
  await mkdir(drive);
  config = {
    ...configFromEnv(db.name),
    backupDir: join(dir, 'copies'),
    driveCredentialsFile: join(dir, 'none.sealed'),
  };
  client = await connect(config.connection);
});
afterAll(async () => {
  await client.end();
  await rm(dir, { recursive: true, force: true });
  await db.drop();
});

const ask = (kind: string, target: string | null = null) =>
  inContext(
    api,
    () =>
      api.query(`INSERT INTO ops.backup_requests (kind, target) VALUES ($1, $2)`, [kind, target]),
    owner,
  );

describe('the external-drive copy', () => {
  it('refuses a missing drive, a relative path or the local backup folder itself', async () => {
    await expect(offlineCopy(client, config, { target: join(dir, 'F-drive') })).rejects.toThrow(
      /not found/,
    );
    await expect(offlineCopy(client, config, { target: 'E:' })).rejects.toThrow(/full path/);
    await mkdir(config.backupDir, { recursive: true });
    await expect(offlineCopy(client, config, { target: config.backupDir })).rejects.toThrow(
      /inside/,
    );
  });

  it('writes a verified copy and a note, and keeps the last 8 copies on the drive', async () => {
    const folder = join(drive, OFFLINE_FOLDER);
    await mkdir(folder);
    for (let i = 1; i <= 9; i++) {
      await writeFile(
        join(folder, backupFileName(new Date(Date.now() - i * 7 * 24 * 3600 * 1000))),
        'old',
      );
    }
    const copy = await offlineCopy(client, config, { target: drive });
    const names = await readdir(folder);
    expect(names).toContain('README.txt');
    expect(names.filter((n) => n.endsWith('.dump'))).toHaveLength(8);
    expect(names).toContain(copy.path.split(/[\\/]/).pop());
    const { rows } = await client.query<{ status: string; encrypted: boolean }>(
      `SELECT status, encrypted FROM ops.backup_runs WHERE id = $1`,
      [copy.runId],
    );
    expect(rows[0]).toEqual({ status: 'success', encrypted: false });
  });
});

describe('the schedule', () => {
  it('makes the hourly copy, the checks after a start and at night once, and carries out the owner’s requests', async () => {
    const now = new Date();
    const anyHour = { nightlyFromHour: 0 };
    // A copy was just made by the drive test: only the check after the database's start (none
    // yet since it started, M6.2 part I) and the nightly check are due.
    expect(await tick(client, config, now, anyHour)).toEqual(['start-check', 'integrity']);
    // Neither is due again.
    expect(await tick(client, config, now, anyHour)).toEqual([]);
    // An hour after the last copy, the next one is due.
    expect(await tick(client, config, new Date(now.getTime() + 61 * 60_000), anyHour)).toContain(
      'local',
    );

    await ask('restore_test');
    await ask('offline_copy', drive);
    await ask('offsite_now');
    await tick(client, config, now, anyHour);
    const { rows } = await client.query<{
      kind: string;
      status: string;
      error_message: string | null;
    }>(`SELECT kind, status, error_message FROM ops.backup_requests ORDER BY id`);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ['restore_test', 'done'],
      ['offline_copy', 'done'],
      ['offsite_now', 'failed'],
    ]);
    expect(rows[2]!.error_message).toMatch(/No backup key/);
  });
});
