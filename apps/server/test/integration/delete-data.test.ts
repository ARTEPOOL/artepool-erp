/**
 * Deleting the server PC's data (decision 0103, M6.2 part G4) on a real PostgreSQL with a fake
 * Windows: without the word DELETE or with a wrong owner password nothing is deleted (a wrong
 * password is in the audit log); with both, the services stop and the database, secrets, settings
 * and setup files go, while the backups folder and the logs stay.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionFor } from '@artepool/node-kit';
import { createTestDatabase, createUser, inContext, type TestDatabase } from '@artepool/testing';
import { DELETED_FOLDERS, deleteData } from '../../src/cli/delete-data/steps';
import { InstallLog } from '../../src/cli/install/log';
import { SecretHasher } from '../../src/platform/crypto/hashing';
import { createDb, createPool, type Db } from '../../src/platform/db/pool';
import { TEST_ARGON2 } from '../support/server';

let root: string;
let database: TestDatabase;
let db: Db;
const hasher = new SecretHasher(TEST_ARGON2);
const password = 'blue-pool-water-71';

async function dataFolder(name: string): Promise<string> {
  const dir = join(root, name);
  for (const folder of [...DELETED_FOLDERS, 'backups', 'logs']) {
    await mkdir(join(dir, folder), { recursive: true });
    await writeFile(join(dir, folder, 'file'), folder);
  }
  return dir;
}

async function events(action: string): Promise<number> {
  const client = await database.connect('superuser');
  try {
    const { rows } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit.log WHERE action = $1',
      [`event:${action}`],
    );
    return rows[0]!.n;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'artepool-delete-data-'));
  database = await createTestDatabase();
  const su = await database.connect('superuser');
  const owner = await createUser(su, {
    username: 'owner',
    signInMethod: 'password_totp',
    roles: ['owner'],
  });
  const hash = await hasher.hash(password);
  await inContext(su, () =>
    su.query('UPDATE auth.users SET password_hash = $1 WHERE id = $2', [hash, owner.toString()]),
  );
  await su.end();
  db = createDb(createPool(connectionFor('api', database.name), 2));
}, 120_000);

afterAll(async () => {
  await db?.destroy().catch(() => undefined);
  await database.drop();
  await rm(root, { recursive: true, force: true });
});

function run(dir: string, answers: { confirmation: string; password: string }) {
  const stopped: string[] = [];
  let closed = false;
  const promise = deleteData({
    db,
    hasher,
    ...answers,
    dataDir: dir,
    closeDb: () => Promise.resolve(void (closed = true)),
    stopService: (service) => Promise.resolve(void stopped.push(service)),
    log: new InstallLog(null, () => undefined),
  });
  return promise.then((result) => ({ result, stopped, closed }));
}

describe('deleting the data', () => {
  it('deletes nothing without the word DELETE', async () => {
    const dir = await dataFolder('not-confirmed');
    const { result, stopped } = await run(dir, { confirmation: 'delete', password });
    expect(result).toEqual({ ok: false, reason: 'not_confirmed' });
    expect(stopped).toEqual([]);
    for (const folder of DELETED_FOLDERS) expect(existsSync(join(dir, folder))).toBe(true);
  });

  it("deletes nothing with a wrong owner's password, and audits the refusal", async () => {
    const dir = await dataFolder('wrong');
    const { result, stopped } = await run(dir, {
      confirmation: 'DELETE',
      password: 'not-it-at-all',
    });
    expect(result).toEqual({ ok: false, reason: 'wrong_password' });
    expect(stopped).toEqual([]);
    expect(existsSync(join(dir, 'pgdata', 'file'))).toBe(true);
    expect(await events('system.data_delete_refused')).toBe(1);
  });

  it('with both, stops the services and deletes all but the backups and the logs', async () => {
    const dir = await dataFolder('right');
    const { result, stopped, closed } = await run(dir, { confirmation: ' DELETE ', password });
    expect(result).toEqual({ ok: true, removed: [...DELETED_FOLDERS] });
    expect(await events('system.data_delete_confirmed')).toBe(1);
    expect(closed).toBe(true);
    expect(stopped).toEqual(['backup', 'server', 'database']);
    for (const folder of DELETED_FOLDERS) expect(existsSync(join(dir, folder))).toBe(false);
    expect(existsSync(join(dir, 'backups', 'file'))).toBe(true);
    expect(existsSync(join(dir, 'logs', 'file'))).toBe(true);
  });
});
