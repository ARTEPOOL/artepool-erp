/**
 * The server PC's updater (decision 0108, M6.2 part G5) on a real PostgreSQL, with the update
 * list and the download faked and a file signed by Tauri's signer (test key) as the "setup":
 * no key or no internet changes nothing; a newer version is downloaded and kept only when its
 * SHA-256 and signature are right; it starts only at a safe time (no open shift; the night window
 * or the owner's "Install now"); the result is recorded and a failed version waits for the owner.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectionFor } from '@artepool/node-kit';
import { createTestDatabase, createUser, inContext, type TestDatabase } from '@artepool/testing';
import { inWindow, runUpdater, setupFileName, type UpdaterDeps } from '../../src/cli/updater/steps';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'update-signature');
const publicKey = await readFile(join(fixtures, 'test.key.pub'), 'utf8');
const signature = await readFile(join(fixtures, 'data.bin.sig'), 'utf8');
const setup = await readFile(join(fixtures, 'data.bin'));
const setupSha = createHash('sha256').update(setup).digest('hex');

/** 12:00 and 03:00 in the shop (Asia/Dubai is UTC+4). */
const NOON = new Date('2026-10-26T08:00:00Z');
const NIGHT = new Date('2026-10-26T23:00:00Z');

let db: TestDatabase;
let client: pg.Client;
let su: pg.Client;
let owner: bigint;
let dir: string;

function latest(version: string, overrides: Record<string, unknown> = {}) {
  return {
    version,
    pub_date: '2026-10-25T10:00:00Z',
    notesAr: 'تحسينات',
    notesEn: 'Improvements',
    server: {
      url: `https://github.com/ARTEPOOL/artepool-releases/releases/download/v${version}/${setupFileName(version)}`,
      signature,
      sha256: setupSha,
    },
    ...overrides,
  };
}

function deps(patch: Partial<UpdaterDeps> & { started?: string[] } = {}): UpdaterDeps & {
  started: string[];
} {
  const started = patch.started ?? [];
  return {
    db: client,
    currentVersion: '1.0.0',
    publicKey,
    updatesDir: dir,
    fetchLatest: () => Promise.resolve(latest('1.1.0')),
    download: (_url, to) => copyFile(join(fixtures, 'data.bin'), to),
    runSetup: (file) => void started.push(file),
    now: () => NOON,
    log: () => undefined,
    ...patch,
    started,
  };
}

async function state() {
  const { rows } = await su.query('SELECT * FROM ops.update_state WHERE id = 1');
  return rows[0] as Record<string, unknown>;
}

async function reset() {
  await inContext(su, async () => {
    await su.query(
      `UPDATE ops.update_state SET checked_at = NULL, check_error = NULL, available_version = NULL,
         notes_ar = NULL, notes_en = NULL, download_status = 'none', waiting_reason = NULL,
         last_result = NULL WHERE id = 1`,
    );
    await su.query(`UPDATE ops.update_requests SET status = 'failed' WHERE status = 'pending'`);
    await su.query(`UPDATE ops.update_requests SET status = 'failed' WHERE status = 'running'`);
  });
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

async function installNow(version: string) {
  await inContext(
    su,
    () => su.query('INSERT INTO ops.update_requests (version) VALUES ($1)', [version]),
    owner,
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  su = await db.connect('superuser');
  owner = await createUser(su, {
    username: 'owner',
    signInMethod: 'password_totp',
    roles: ['owner'],
  });
  client = new pg.Client(connectionFor('backup', db.name));
  await client.connect();
  dir = join(await mkdtemp(join(tmpdir(), 'artepool-updater-')), 'updates');
}, 120_000);

afterAll(async () => {
  await client.end();
  await su.end();
  await db.drop();
  await rm(join(dir, '..'), { recursive: true, force: true });
});

beforeEach(reset);

describe('the night window', () => {
  it('is read in the shop time and may cross midnight', () => {
    expect(inWindow(NIGHT, 2, 5)).toBe(true);
    expect(inWindow(NOON, 2, 5)).toBe(false);
    expect(inWindow(NIGHT, 22, 4)).toBe(true);
    expect(inWindow(NOON, 22, 4)).toBe(false);
  });
});

describe('the server PC updater', () => {
  it('accepts nothing without the update key', async () => {
    const d = deps({ publicKey: '' });
    expect(await runUpdater(d)).toBe('no_key');
    expect((await state()).check_error).toMatch(/update key is not set/);
    expect(d.started).toEqual([]);
  });

  it('keeps working without internet: the update waits', async () => {
    const d = deps({ fetchLatest: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')) });
    expect(await runUpdater(d)).toBe('offline');
    const s = await state();
    expect(s.check_error).toBe('getaddrinfo ENOTFOUND');
    expect(s.checked_at).not.toBeNull();
    expect(s.current_version).toBe('1.0.0');
  });

  it('says up to date when nothing newer is published', async () => {
    expect(await runUpdater(deps({ fetchLatest: () => Promise.resolve(latest('1.0.0')) }))).toBe(
      'up_to_date',
    );
    expect((await state()).available_version).toBeNull();
  });

  it('downloads and checks a newer version, then waits for the night', async () => {
    const d = deps();
    expect(await runUpdater(d)).toBe('waiting');
    const s = await state();
    expect(s).toMatchObject({
      available_version: '1.1.0',
      notes_ar: 'تحسينات',
      notes_en: 'Improvements',
      download_status: 'ready',
      waiting_reason: 'outside_window',
    });
    expect(existsSync(join(dir, setupFileName('1.1.0')))).toBe(true);
    expect(d.started).toEqual([]);

    // At night it starts the setup, once; the next run sees it is still installing.
    const night = deps({ now: () => NIGHT });
    expect(await runUpdater(night)).toBe('started');
    expect(night.started).toEqual([join(dir, setupFileName('1.1.0'))]);
    expect((await state()).waiting_reason).toBe('installing');
    expect(await runUpdater(deps({ now: () => NIGHT }))).toBe('installing');

    // The setup's result is recorded; the new version is running.
    await writeFile(
      join(dir, 'last-result.json'),
      JSON.stringify({ ok: true, from: '1.0.0', to: '1.1.0', at: '2026-10-26T23:10:00.000Z' }),
    );
    const after = deps({ currentVersion: '1.1.0', now: () => NIGHT });
    expect(await runUpdater(after)).toBe('up_to_date');
    expect((await state()).last_result).toMatchObject({ ok: true, to: '1.1.0' });
    expect(existsSync(join(dir, 'installing.json'))).toBe(false);
  });

  it('refuses a download with a wrong SHA-256 or a wrong signature', async () => {
    const wrongSha = deps({
      fetchLatest: () => Promise.resolve(latest('1.1.0', {})),
      download: (_url, to) => writeFile(to, 'something else'),
      now: () => NIGHT,
    });
    expect(await runUpdater(wrongSha)).toBe('download_failed');
    expect(existsSync(join(dir, setupFileName('1.1.0')))).toBe(false);
    expect(wrongSha.started).toEqual([]);

    const other = Buffer.from('a forged setup');
    const forged = deps({
      fetchLatest: () =>
        Promise.resolve(
          latest('1.1.0', {
            server: {
              ...latest('1.1.0').server,
              sha256: createHash('sha256').update(other).digest('hex'),
            },
          }),
        ),
      download: (_url, to) => writeFile(to, other),
      now: () => NIGHT,
    });
    expect(await runUpdater(forged)).toBe('download_failed');
    expect((await state()).download_status).toBe('failed');
    expect(forged.started).toEqual([]);
  });

  it('never starts while a shift is open, even after "Install now"', async () => {
    await installNow('1.1.0');
    await su.query('SET session_replication_role = replica');
    await inContext(su, () =>
      su.query(
        `INSERT INTO cash.shifts (series_id, seq_no, shift_number, register_id, cashier_id,
                                  opened_by, opening_float_fils, created_by, updated_by)
         VALUES (1, 1, 'SH-UPD', 1, 1, 1, 0, 1, 1)`,
      ),
    );
    await su.query('SET session_replication_role = DEFAULT');
    try {
      const d = deps({ now: () => NIGHT });
      expect(await runUpdater(d)).toBe('waiting');
      expect((await state()).waiting_reason).toBe('open_shift');
      expect(d.started).toEqual([]);
    } finally {
      await su.query('SET session_replication_role = replica');
      await su.query(`DELETE FROM cash.shifts WHERE shift_number = 'SH-UPD'`);
      await su.query('SET session_replication_role = DEFAULT');
    }
  });

  it('"Install now" starts at once; a failed version then waits for the owner', async () => {
    await installNow('1.1.0');
    const d = deps();
    expect(await runUpdater(d)).toBe('started');
    expect(d.started).toHaveLength(1);
    const running = await su.query(
      `SELECT status FROM ops.update_requests WHERE status = 'running'`,
    );
    expect(running.rowCount).toBe(1);

    await writeFile(
      join(dir, 'last-result.json'),
      JSON.stringify({
        ok: false,
        from: '1.0.0',
        to: '1.1.0',
        at: '2026-10-26T08:05:00.000Z',
        step: 'migrate',
        detail: 'boom',
      }),
    );
    // Back on 1.0.0 (rolled back): at night it is not tried again by itself.
    const night = deps({ now: () => NIGHT });
    expect(await runUpdater(night)).toBe('waiting');
    expect((await state()).waiting_reason).toBe('failed_before');
    expect(night.started).toEqual([]);
    const failed = await su.query<{ error_message: string }>(
      `SELECT error_message FROM ops.update_requests ORDER BY id DESC LIMIT 1`,
    );
    expect(failed.rows[0]!.error_message).toBe('migrate: boom');
  });
});
