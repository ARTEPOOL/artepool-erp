/**
 * The server PC's updater (decision 0108, M6.2 part G5) on a real PostgreSQL, with the update
 * list and the download faked and a file signed by Tauri's signer (test key) as the "setup":
 * no key or no internet changes nothing; a newer version is downloaded and kept only when its
 * SHA-256 and signature are right; it starts only at a safe time (no open shift; the night window
 * or the owner's "Install now"); the result is recorded and a failed version waits for the owner;
 * the version just installed is forgotten at once; the owner's "Check now" (0110) reads the list
 * on the next run. The smallest package that fits (0115, 0.9.0): the update package alone, with
 * the runtime package, or the full setup; a refused or failed small package means the full setup
 * for that version.
 */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectionFor } from '@artepool/node-kit';
import { createTestDatabase, createUser, inContext, type TestDatabase } from '@artepool/testing';
import { RUNTIME_FILES } from '../../src/cli/upgrade/steps';
import {
  inWindow,
  runtimeDirName,
  runUpdater,
  setupFileName,
  updateFileName,
  useFullMarker,
  type UpdaterDeps,
} from '../../src/cli/updater/steps';
import { RUNTIME_ZIP_NAMES, testUpdateKey, zipWith } from '../support/update-key';

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
    // Installed before 0.9.0 unless a test says otherwise: the full setup.
    installedRuntime: () => Promise.resolve(null),
    unzip: () => Promise.reject(new Error('no runtime package in this test')),
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
  await inContext(
    su,
    () => su.query('UPDATE ops.update_state SET check_requested_at = NULL WHERE id = 1'),
    owner,
  );
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

  it('forgets the version just installed at once, even minutes after the last check', async () => {
    const before = new Date(NIGHT.getTime() - 6 * 60_000);
    await installNow('1.1.0');
    expect(await runUpdater(deps({ now: () => before }))).toBe('started');
    await writeFile(
      join(dir, 'last-result.json'),
      JSON.stringify({ ok: true, from: '1.0.0', to: '1.1.0', at: before.toISOString() }),
    );
    let reads = 0;
    const after = deps({
      currentVersion: '1.1.0',
      now: () => NIGHT,
      fetchLatest: () => {
        reads++;
        return Promise.resolve(latest('1.1.0'));
      },
    });
    expect(await runUpdater(after)).toBe('up_to_date');
    const s = await state();
    expect(s).toMatchObject({
      current_version: '1.1.0',
      available_version: null,
      notes_ar: null,
      download_status: 'none',
      waiting_reason: null,
    });
    // Read again at once after the update, not hours later.
    expect(reads).toBe(1);
    expect(s.checked_at).toEqual(NIGHT);
    expect(existsSync(join(dir, setupFileName('1.1.0')))).toBe(false);
    expect(existsSync(join(dir, `${setupFileName('1.1.0')}.sig`))).toBe(false);
  });

  it('reads the list on the next run after the owner\'s "Check now", and only then', async () => {
    let reads = 0;
    const at = (minutes: number) => () => new Date(NOON.getTime() + minutes * 60_000);
    const counting = (minutes: number) =>
      deps({
        now: at(minutes),
        fetchLatest: () => {
          reads++;
          return Promise.resolve(latest('1.0.0'));
        },
      });
    expect(await runUpdater(counting(0))).toBe('up_to_date');
    expect(await runUpdater(counting(5))).toBe('up_to_date');
    expect(reads).toBe(1);

    await inContext(
      su,
      () => su.query('UPDATE ops.update_state SET check_requested_at = $1 WHERE id = 1', [at(7)()]),
      owner,
    );
    expect(await runUpdater(counting(10))).toBe('up_to_date');
    expect(reads).toBe(2);
    expect((await state()).checked_at).toEqual(at(10)());
    expect(await runUpdater(counting(15))).toBe('up_to_date');
    expect(reads).toBe(2);
  });

  it('lets only the owner ask to check now', async () => {
    const cashier = await createUser(su, { username: 'cashier-check', roles: ['cashier'] });
    await expect(
      inContext(
        su,
        () => su.query('UPDATE ops.update_state SET check_requested_at = now() WHERE id = 1'),
        cashier,
      ),
    ).rejects.toMatchObject({ code: 'AP010' });
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

describe('fast updates (decision 0115)', () => {
  const half = Math.floor(setup.length / 2);

  it('reads the list by itself every hour, not every few hours', async () => {
    let reads = 0;
    const at = (minutes: number) =>
      deps({
        now: () => new Date(NOON.getTime() + minutes * 60_000),
        fetchLatest: () => {
          reads++;
          return Promise.resolve(latest('1.0.0'));
        },
      });
    await runUpdater(at(0));
    await runUpdater(at(59));
    expect(reads).toBe(1);
    await runUpdater(at(60));
    expect(reads).toBe(2);
  });

  it('downloads in advance when the server already read the list for "Check now"', async () => {
    // What the server records for the owner's "Check now": a newer version, nothing downloaded.
    await inContext(
      su,
      () =>
        su.query(
          `UPDATE ops.update_state SET checked_at = $1, available_version = '1.1.0',
             notes_ar = 'تحسينات', notes_en = 'Improvements' WHERE id = 1`,
          [NOON],
        ),
      owner,
    );
    let reads = 0;
    const d = deps({
      fetchLatest: () => {
        reads++;
        return Promise.resolve(latest('1.1.0'));
      },
    });
    // The updater takes the address and the checks from the list it reads itself.
    expect(await runUpdater(d)).toBe('waiting');
    expect(reads).toBe(1);
    expect(await state()).toMatchObject({
      download_status: 'ready',
      waiting_reason: 'outside_window',
    });
    expect(existsSync(join(dir, setupFileName('1.1.0')))).toBe(true);
  });

  it('a cut keeps what arrived; the next run continues it; the progress is never audited', async () => {
    const partial = join(dir, `${setupFileName('1.1.0')}.partial`);
    let clock = 0;
    const cut = deps({
      clock: () => (clock += 400),
      download: async (_url, to, onProgress) => {
        await writeFile(to, setup.subarray(0, half));
        onProgress(half, setup.length);
        throw new Error('ECONNRESET');
      },
    });
    expect(await runUpdater(cut)).toBe('download_failed');
    expect(await state()).toMatchObject({
      download_status: 'failed',
      download_bytes: String(half),
      download_total: String(setup.length),
    });
    expect((await readFile(partial)).length).toBe(half);

    let continuedFrom = -1;
    const next = deps({
      clock: () => (clock += 400),
      download: async (_url, to, onProgress) => {
        continuedFrom = (await readFile(to)).length;
        await writeFile(to, setup);
        onProgress(setup.length, setup.length);
      },
    });
    expect(await runUpdater(next)).toBe('waiting');
    expect(continuedFrom).toBe(half);
    expect(await state()).toMatchObject({
      download_status: 'ready',
      download_bytes: String(setup.length),
      download_total: String(setup.length),
    });
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(`${partial}.json`)).toBe(false);

    // Status changes are in the audit log; the bytes, total, speed and time never are.
    const { rows } = await su.query<{ keys: string[] }>(
      `SELECT ARRAY(SELECT jsonb_object_keys(coalesce(new_values, '{}'))) AS keys
         FROM audit.log WHERE entity_type = 'ops.update_state'`,
    );
    const keys = rows.flatMap((r) => r.keys);
    expect(keys).toContain('download_status');
    for (const quiet of ['download_bytes', 'download_total', 'download_rate', 'progress_at']) {
      expect(keys).not.toContain(quiet);
    }
  });

  it('a part of another file is thrown away; a wrong file is deleted, not continued', async () => {
    const partial = join(dir, `${setupFileName('1.1.0')}.partial`);
    await mkdir(dir, { recursive: true });
    await writeFile(partial, Buffer.from('left from another version'));
    await writeFile(
      `${partial}.json`,
      JSON.stringify({ url: 'https://old', sha256: 'f'.repeat(64) }),
    );
    let startedWith = -1;
    const fresh = deps({
      download: async (_url, to) => {
        startedWith = existsSync(to) ? (await readFile(to)).length : 0;
        await writeFile(to, Buffer.from('not the setup'));
      },
    });
    expect(await runUpdater(fresh)).toBe('download_failed');
    expect(startedWith).toBe(0);
    // Its SHA-256 is wrong: deleted with its note, and the progress is emptied.
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(`${partial}.json`)).toBe(false);
    expect(await state()).toMatchObject({ download_status: 'failed', download_bytes: null });
  });

  it('the speed is worked out, and the progress is written at most once a second', async () => {
    let clock = 0;
    const writes: number[] = [];
    const d = deps({
      clock: () => clock,
      download: async (_url, to, onProgress) => {
        // Ten reports, 200 ms apart: two seconds in all.
        for (let i = 1; i <= 10; i++) {
          clock += 200;
          onProgress(Math.round((setup.length * i) / 10), setup.length);
        }
        await writeFile(to, setup);
      },
    });
    const query = client.query.bind(client);
    client.query = ((text: unknown, ...rest: unknown[]) => {
      if (typeof text === 'string' && text.includes('download_bytes')) writes.push(clock);
      return (query as (...args: unknown[]) => unknown)(text, ...rest);
    }) as typeof client.query;
    try {
      expect(await runUpdater(d)).toBe('waiting');
    } finally {
      client.query = query;
    }
    // At most one a second while downloading (0, 1000, 2000 ms), plus the last one.
    expect(writes.length).toBeLessThanOrEqual(4);
    const s = await state();
    expect(s.download_bytes).toBe(String(setup.length));
    expect(Number(s.download_rate)).toBeGreaterThan(0);
  });

  it("the server's role records a check only for the owner, and never the progress", async () => {
    const api = new pg.Client(connectionFor('api', db.name));
    await api.connect();
    try {
      const cashier = await createUser(su, { username: 'cashier-list', roles: ['cashier'] });
      await expect(
        inContext(
          api,
          () => api.query(`UPDATE ops.update_state SET available_version = '9.9.9' WHERE id = 1`),
          cashier,
        ),
      ).rejects.toMatchObject({ code: 'AP010' });
      await inContext(
        api,
        () => api.query(`UPDATE ops.update_state SET available_version = '1.1.0' WHERE id = 1`),
        owner,
      );
      // The progress is the updater's alone.
      await expect(
        inContext(
          api,
          () => api.query('UPDATE ops.update_state SET download_bytes = 1 WHERE id = 1'),
          owner,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.end();
    }
  });
});

describe('the smallest package that fits (decision 0115, 0.9.0)', () => {
  const key = testUpdateKey();
  const RID = '0123456789ab';
  const OTHER = 'ba9876543210';
  const download = (name: string) =>
    `https://github.com/ARTEPOOL/artepool-releases/releases/download/v1.1.0/${name}`;
  const bytes = {
    full: Buffer.from('MZ the full setup, PostgreSQL and Node inside'),
    update: Buffer.from('MZ the programs only'),
    runtime: zipWith(RUNTIME_ZIP_NAMES),
  };
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const listed = (name: string, b: Buffer) => ({
    url: download(name),
    signature: key.signFile(b, name),
    sha256: sha(b),
    size: b.length,
  });
  const runtimeName = `ARTEPOOL-Runtime-${RID}.zip`;

  /** A list with every package; `runtimeBytes` replaces the published runtime package. */
  function smallList(runtimeBytes: Buffer = bytes.runtime) {
    return {
      ...latest('1.1.0'),
      server: listed(setupFileName('1.1.0'), bytes.full),
      serverUpdate: { ...listed(updateFileName('1.1.0'), bytes.update), runtime: RID },
      runtime: { id: RID, ...listed(runtimeName, runtimeBytes) },
    };
  }

  /** Downloads by address; what was asked is kept in `asked`. */
  function server(files: Record<string, Buffer>, asked: string[]) {
    return async (url: string, to: string, onProgress: (r: number, t: number | null) => void) => {
      asked.push(url.split('/').at(-1)!);
      const body = files[url.split('/').at(-1)!];
      if (!body) throw new Error(`404 ${url}`);
      await writeFile(to, body);
      onProgress(body.length, body.length);
    };
  }

  const published = (runtimeBytes = bytes.runtime) => ({
    [setupFileName('1.1.0')]: bytes.full,
    [updateFileName('1.1.0')]: bytes.update,
    [runtimeName]: runtimeBytes,
  });

  /** What Windows' tar would unpack: the runtime with this id and its programs. */
  const unzipRuntime = (id: string) => async (_zip: string, to: string) => {
    await writeFile(join(to, 'runtime.json'), JSON.stringify({ id, layout: 1 }));
    for (const parts of RUNTIME_FILES) {
      await mkdir(join(to, ...parts.slice(0, -1)), { recursive: true });
      await writeFile(join(to, ...parts), 'MZ');
    }
  };

  function small(
    patch: Partial<UpdaterDeps> & { asked?: string[]; runs?: [string, string | null][] },
  ) {
    const runs = patch.runs ?? [];
    const asked = patch.asked ?? [];
    return deps({
      publicKey: key.publicKey,
      fetchLatest: () => Promise.resolve(smallList()),
      download: server(published(), asked),
      installedRuntime: () => Promise.resolve(RID),
      unzip: unzipRuntime(RID),
      runSetup: (file, runtimeDir) => void runs.push([file, runtimeDir]),
      ...patch,
    });
  }

  it('the PC has the runtime it needs: only the update package is downloaded and run', async () => {
    const asked: string[] = [];
    const runs: [string, string | null][] = [];
    await installNow('1.1.0');
    expect(await runUpdater(small({ asked, runs }))).toBe('started');
    expect(asked).toEqual([updateFileName('1.1.0')]);
    expect(runs).toEqual([[join(dir, updateFileName('1.1.0')), null]]);
    expect(await state()).toMatchObject({
      download_bytes: String(bytes.update.length),
      download_total: String(bytes.update.length),
    });
    const started = JSON.parse(await readFile(join(dir, 'installing.json'), 'utf8')) as {
      package: string;
    };
    expect(started.package).toBe('update');
  });

  it('another runtime: the runtime package too, one progress bar, unpacked and checked before the setup', async () => {
    const asked: string[] = [];
    const runs: [string, string | null][] = [];
    const d = small({ asked, runs, installedRuntime: () => Promise.resolve(OTHER) });
    expect(await runUpdater(d)).toBe('waiting');
    expect(asked).toEqual([runtimeName, updateFileName('1.1.0')]);
    // One bar for both files.
    expect(await state()).toMatchObject({
      download_status: 'ready',
      download_bytes: String(bytes.runtime.length + bytes.update.length),
      download_total: String(bytes.runtime.length + bytes.update.length),
    });
    // Not unpacked until it is installed.
    expect(existsSync(join(dir, runtimeDirName(RID)))).toBe(false);

    await installNow('1.1.0');
    const install = small({ asked, runs, installedRuntime: () => Promise.resolve(OTHER) });
    expect(await runUpdater(install)).toBe('started');
    // Nothing downloaded twice.
    expect(asked).toEqual([runtimeName, updateFileName('1.1.0')]);
    const runtimeDir = join(dir, runtimeDirName(RID));
    expect(runs).toEqual([[join(dir, updateFileName('1.1.0')), runtimeDir]]);
    expect(existsSync(join(runtimeDir, 'pgsql', 'bin', 'postgres.exe'))).toBe(true);
  });

  it('the full setup when the PC was installed before 0.9.0, or the list has no small packages', async () => {
    const asked: string[] = [];
    const runs: [string, string | null][] = [];
    await installNow('1.1.0');
    expect(
      await runUpdater(small({ asked, runs, installedRuntime: () => Promise.resolve(null) })),
    ).toBe('started');
    expect(asked).toEqual([setupFileName('1.1.0')]);
    expect(runs).toEqual([[join(dir, setupFileName('1.1.0')), null]]);

    await reset();
    const old = { ...smallList(), serverUpdate: undefined, runtime: undefined };
    const asked2: string[] = [];
    await installNow('1.1.0');
    expect(
      await runUpdater(small({ asked: asked2, fetchLatest: () => Promise.resolve(old) })),
    ).toBe('started');
    expect(asked2).toEqual([setupFileName('1.1.0')]);
  });

  it('a refused update package: the full setup for that version from then on', async () => {
    const asked: string[] = [];
    const forged = {
      ...published(),
      [updateFileName('1.1.0')]: Buffer.from('MZ something else'),
    };
    expect(await runUpdater(small({ asked, download: server(forged, asked) }))).toBe(
      'download_failed',
    );
    expect(existsSync(join(dir, updateFileName('1.1.0')))).toBe(false);
    expect(existsSync(join(dir, useFullMarker('1.1.0')))).toBe(true);
    expect((await state()).download_status).toBe('failed');

    const runs: [string, string | null][] = [];
    await installNow('1.1.0');
    expect(await runUpdater(small({ asked, runs }))).toBe('started');
    expect(asked.at(-1)).toBe(setupFileName('1.1.0'));
    expect(runs).toEqual([[join(dir, setupFileName('1.1.0')), null]]);
  });

  it('a runtime package holding anything else, or another runtime, is refused before the setup starts', async () => {
    // Signed and listed as published, but with a program the runtime may not hold.
    const extra = zipWith([...RUNTIME_ZIP_NAMES, 'server/server.mjs']);
    const asked: string[] = [];
    const runs: [string, string | null][] = [];
    const bad = {
      asked,
      runs,
      installedRuntime: () => Promise.resolve(OTHER),
      fetchLatest: () => Promise.resolve(smallList(extra)),
      download: server(published(extra), asked),
    };
    await installNow('1.1.0');
    expect(await runUpdater(small(bad))).toBe('download_failed');
    expect(runs).toEqual([]);
    expect(existsSync(join(dir, useFullMarker('1.1.0')))).toBe(true);
    expect(existsSync(join(dir, runtimeDirName(RID)))).toBe(false);
    // The next run takes the full setup.
    expect(await runUpdater(small({ ...bad }))).toBe('started');
    expect(runs).toEqual([[join(dir, setupFileName('1.1.0')), null]]);

    // A package whose runtime.json names another runtime is refused the same way.
    await reset();
    const runs2: [string, string | null][] = [];
    await installNow('1.1.0');
    expect(
      await runUpdater(
        small({
          runs: runs2,
          installedRuntime: () => Promise.resolve(OTHER),
          unzip: unzipRuntime(OTHER),
        }),
      ),
    ).toBe('download_failed');
    expect(runs2).toEqual([]);
    expect(existsSync(join(dir, useFullMarker('1.1.0')))).toBe(true);
  });

  it('a small package that did not install: the next try of that version takes the full setup', async () => {
    const runs: [string, string | null][] = [];
    await installNow('1.1.0');
    expect(await runUpdater(small({ runs }))).toBe('started');
    expect(runs.at(-1)![0]).toBe(join(dir, updateFileName('1.1.0')));
    await writeFile(
      join(dir, 'last-result.json'),
      JSON.stringify({
        ok: false,
        from: '1.0.0',
        to: '1.1.0',
        at: '2026-10-26T08:05:00.000Z',
        step: 'checks',
        detail: 'This update needs runtime 0123456789ab',
      }),
    );
    // The result is read (the version waits for the owner), then the owner presses it again.
    expect(await runUpdater(small({ runs }))).toBe('waiting');
    expect((await state()).waiting_reason).toBe('failed_before');
    await installNow('1.1.0');
    expect(await runUpdater(small({ runs }))).toBe('started');
    expect(runs.at(-1)).toEqual([join(dir, setupFileName('1.1.0')), null]);
  });

  it('once the version is installed, everything kept for it goes', async () => {
    await installNow('1.1.0');
    expect(await runUpdater(small({ installedRuntime: () => Promise.resolve(OTHER) }))).toBe(
      'started',
    );
    await writeFile(join(dir, useFullMarker('1.0.9')), '');
    await writeFile(
      join(dir, 'last-result.json'),
      JSON.stringify({ ok: true, from: '1.0.0', to: '1.1.0', at: '2026-10-26T08:10:00.000Z' }),
    );
    expect(
      await runUpdater(
        small({ currentVersion: '1.1.0', fetchLatest: () => Promise.resolve(latest('1.1.0')) }),
      ),
    ).toBe('up_to_date');
    const left = (await readdir(dir)).filter((name) =>
      /^(ARTEPOOL-|runtime-|use-full-|plan\.json)/.test(name),
    );
    expect(left).toEqual([]);
  });
});
