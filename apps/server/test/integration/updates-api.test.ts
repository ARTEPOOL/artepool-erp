/**
 * System health → updates (decision 0108) through the API: owner only; the state the server PC's
 * updater keeps (version, release notes in Arabic and English, waiting reason, last result);
 * "Install now" only for a downloaded, checked version, one at a time, audited; the night window;
 * the version running is never shown as new; "Check now" (0110), owner only, audited.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UpdateStatus } from '@artepool/shared/contracts';
import { addOwnerWithTwoStep } from '../support/https';
import {
  addDevice,
  addUser,
  call,
  errorCode,
  openSession,
  startTestServer,
  type TestDevice,
  type TestServer,
} from '../support/server';

let server: TestServer;
let office: TestDevice;
let ownerToken: string;
let accountantToken: string;

/** What the update list answers next (0115); no internet unless a test says otherwise. */
let listAnswer: () => Promise<unknown> = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
let wakes = 0;

beforeAll(async () => {
  server = await startTestServer(undefined, {
    updates: { fetchLatest: () => listAnswer(), wake: () => void wakes++ },
  });
  office = await addDevice(server, { code: 'OFFICE-01', kind: 'office' });
  const owner = await addOwnerWithTwoStep(server, { username: 'owner.main' });
  ownerToken = (
    await openSession(server, { userId: owner.id, deviceId: office.id, method: 'password_totp' })
  ).token;
  const accountant = await addUser(server, { username: 'khaled.acc', roles: ['accountant'] });
  accountantToken = (await openSession(server, { userId: accountant, deviceId: office.id })).token;
});
afterAll(() => server.close());

const get = (token = ownerToken) =>
  call(server, 'GET', '/api/v1/system/update', { device: office, token });
const write = (method: 'POST' | 'PUT', url: string, body: unknown = {}, token = ownerToken) =>
  call(server, method, url, { device: office, token, body, idempotencyKey: randomUUID() });

/** As the updater would leave it (it writes as the backup role, as SYSTEM). */
async function updaterState(values: string) {
  await server.admin.query('BEGIN');
  await server.admin.query("SELECT sys.set_context(1, p_reason => 'test: updater')");
  await server.admin.query(`UPDATE ops.update_state SET ${values} WHERE id = 1`);
  await server.admin.query('COMMIT');
}

describe('updates in System health', () => {
  it('are for the owner only', async () => {
    expect(errorCode(await get(accountantToken))).toBe('PERMISSION_DENIED');
    expect(
      errorCode(await write('POST', '/api/v1/system/update/install-now', {}, accountantToken)),
    ).toBe('PERMISSION_DENIED');
    expect(errorCode(await write('POST', '/api/v1/system/update/check', {}, accountantToken))).toBe(
      'PERMISSION_DENIED',
    );
    expect(
      errorCode(
        await write(
          'PUT',
          '/api/v1/system/update/window',
          { startHour: 1, endHour: 4 },
          accountantToken,
        ),
      ),
    ).toBe('PERMISSION_DENIED');
  });

  it('show nothing to install on a new system, and refuse "Install now"', async () => {
    const status = (await get()).json<UpdateStatus>();
    expect(status).toMatchObject({
      available: null,
      downloadStatus: 'none',
      lastResult: null,
      window: { startHour: 2, endHour: 5 },
      request: null,
    });
    expect(errorCode(await write('POST', '/api/v1/system/update/install-now'))).toBe(
      'UPDATE_NOT_AVAILABLE',
    );
  });

  it('show a downloaded version with its notes; "Install now" once, audited', async () => {
    await updaterState(`current_version = '1.0.0', available_version = '1.1.0',
      notes_ar = 'تحسينات في الكاشير', notes_en = 'POS improvements', download_status = 'ready',
      waiting_reason = 'outside_window',
      last_result = '{"ok": false, "from": "0.9.0", "to": "1.0.0", "at": "2026-10-20T23:00:00Z", "step": "migrate"}'`);
    const status = (await get()).json<UpdateStatus>();
    expect(status).toMatchObject({
      currentVersion: '1.0.0',
      available: { version: '1.1.0', notesAr: 'تحسينات في الكاشير', notesEn: 'POS improvements' },
      downloadStatus: 'ready',
      waitingReason: 'outside_window',
      lastResult: { ok: false, step: 'migrate' },
    });

    const first = await write('POST', '/api/v1/system/update/install-now');
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ version: '1.1.0' });
    expect(errorCode(await write('POST', '/api/v1/system/update/install-now'))).toBe(
      'UPDATE_REQUEST_OPEN',
    );
    expect((await get()).json<UpdateStatus>().request).toEqual({
      version: '1.1.0',
      status: 'pending',
    });
    const audit = await server.admin.query<{ reason: string }>(
      `SELECT reason FROM audit.log WHERE entity_type = 'ops.update_requests'`,
    );
    expect(audit.rows.map((r) => r.reason)).toEqual(['install the downloaded update now']);
  });

  it('never show the version running as new, and refuse "Install now" for it', async () => {
    await updaterState(`current_version = '1.1.0', available_version = '1.1.0',
      download_status = 'ready', waiting_reason = 'installing'`);
    await server.admin.query('BEGIN');
    await server.admin.query("SELECT sys.set_context(1, p_reason => 'test: updater')");
    await server.admin.query(
      `UPDATE ops.update_requests SET status = 'failed' WHERE status IN ('pending', 'running')`,
    );
    await server.admin.query('COMMIT');
    const status = (await get()).json<UpdateStatus>();
    expect(status).toMatchObject({ currentVersion: '1.1.0', available: null });
    expect(errorCode(await write('POST', '/api/v1/system/update/install-now'))).toBe(
      'UPDATE_NOT_AVAILABLE',
    );
  });

  it('"Check now" asks the server PC to read the list; checking until it has, audited', async () => {
    await updaterState(`checked_at = now() - interval '1 hour'`);
    expect((await get()).json<UpdateStatus>().checking).toBe(false);
    const asked = await write('POST', '/api/v1/system/update/check');
    expect(asked.statusCode).toBe(201);
    expect((await get()).json<UpdateStatus>().checking).toBe(true);
    // The updater read the list after the request.
    await updaterState(`checked_at = now() + interval '1 second'`);
    expect((await get()).json<UpdateStatus>().checking).toBe(false);
    const audit = await server.admin.query<{ reason: string }>(
      `SELECT reason FROM audit.log WHERE entity_type = 'ops.update_state'
        AND reason = 'check for updates now'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it('change the night window, never to an empty one', async () => {
    expect(
      (await write('PUT', '/api/v1/system/update/window', { startHour: 23, endHour: 4 }))
        .statusCode,
    ).toBe(200);
    expect((await get()).json<UpdateStatus>().window).toEqual({ startHour: 23, endHour: 4 });
    expect(
      errorCode(await write('PUT', '/api/v1/system/update/window', { startHour: 3, endHour: 3 })),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('fast updates (decision 0115)', () => {
  const list = (version: string) => ({
    version,
    pub_date: '2026-10-31T10:00:00Z',
    notesAr: 'أسرع',
    notesEn: 'Faster',
    server: {
      url: `https://github.com/ARTEPOOL/artepool-releases/releases/download/v${version}/s.exe`,
      signature: 'sig',
      sha256: 'a'.repeat(64),
    },
  });

  it('"Check now" answers in the same request and wakes the updater after the commit', async () => {
    await updaterState(
      `current_version = '1.1.0', available_version = NULL, download_status = 'none', checked_at = NULL`,
    );
    listAnswer = () => Promise.resolve(list('1.2.0'));
    const before = wakes;
    const asked = await write('POST', '/api/v1/system/update/check');
    expect(asked.statusCode).toBe(201);
    expect(asked.json()).toEqual({ ok: true, available: '1.2.0', error: null });
    expect(wakes).toBe(before + 1);
    const status = (await get()).json<UpdateStatus>();
    expect(status).toMatchObject({
      checking: false,
      checkError: null,
      available: { version: '1.2.0', notesAr: 'أسرع', notesEn: 'Faster' },
    });
    // The owner's request and what was found are in the audit log.
    const audit = await server.admin.query<{ keys: string[] }>(
      `SELECT ARRAY(SELECT jsonb_object_keys(new_values)) AS keys FROM audit.log
        WHERE entity_type = 'ops.update_state' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]!.keys).toEqual(
      expect.arrayContaining(['check_requested_at', 'available_version', 'checked_at']),
    );
  });

  it('nothing newer: says so at once; no internet: the updater reads it instead', async () => {
    listAnswer = () => Promise.resolve(list('1.1.0'));
    expect((await write('POST', '/api/v1/system/update/check')).json()).toEqual({
      ok: true,
      available: null,
      error: null,
    });
    expect((await get()).json<UpdateStatus>()).toMatchObject({ checking: false, available: null });

    listAnswer = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    const before = wakes;
    expect((await write('POST', '/api/v1/system/update/check')).json()).toMatchObject({
      ok: true,
      available: null,
      error: 'getaddrinfo ENOTFOUND',
    });
    // Still "checking": the updater (woken) reads the list itself.
    expect((await get()).json<UpdateStatus>().checking).toBe(true);
    expect(wakes).toBe(before + 1);
  });

  it('"Install now" wakes the updater at once; a refused one or a replay does not', async () => {
    await server.admin
      .query(
        `UPDATE ops.update_requests SET status = 'failed'
                                WHERE status IN ('pending', 'running')`,
      )
      .catch(() => undefined);
    await updaterState(
      `current_version = '1.1.0', available_version = '1.2.0', download_status = 'ready'`,
    );
    const before = wakes;
    const key = randomUUID();
    const first = await call(server, 'POST', '/api/v1/system/update/install-now', {
      device: office,
      token: ownerToken,
      body: {},
      idempotencyKey: key,
    });
    expect(first.statusCode).toBe(201);
    expect(wakes).toBe(before + 1);
    // The same request again (a retry): the first answer, no second wake.
    const again = await call(server, 'POST', '/api/v1/system/update/install-now', {
      device: office,
      token: ownerToken,
      body: {},
      idempotencyKey: key,
    });
    expect(again.statusCode).toBe(201);
    expect(wakes).toBe(before + 1);
    // Refused (already waiting): nothing was committed, nobody is woken.
    expect(errorCode(await write('POST', '/api/v1/system/update/install-now'))).toBe(
      'UPDATE_REQUEST_OPEN',
    );
    expect(wakes).toBe(before + 1);
  });

  it('shows the download progress the updater writes', async () => {
    await updaterState(
      `download_status = 'downloading', download_bytes = 120000000, download_total = 288000000,
       download_rate = 2500000, progress_at = now()`,
    );
    expect((await get()).json<UpdateStatus>().progress).toMatchObject({
      receivedBytes: 120_000_000,
      totalBytes: 288_000_000,
      bytesPerSecond: 2_500_000,
    });
    await updaterState(
      `download_bytes = NULL, download_total = NULL, download_rate = NULL, progress_at = NULL`,
    );
    expect((await get()).json<UpdateStatus>().progress).toBeNull();
  });

  it("shows the last update's steps, its reason and the status page's times, nothing else", async () => {
    const steps = [
      {
        step: 'prepare',
        state: 'done',
        startedAt: '2026-11-05T23:00:00Z',
        endedAt: '2026-11-05T23:00:20Z',
      },
      {
        step: 'stop',
        state: 'done',
        startedAt: '2026-11-05T23:00:20Z',
        endedAt: '2026-11-05T23:00:25Z',
      },
      {
        step: 'backup',
        state: 'done',
        startedAt: '2026-11-05T23:00:25Z',
        endedAt: '2026-11-05T23:01:05Z',
      },
      {
        step: 'database',
        state: 'failed',
        startedAt: '2026-11-05T23:01:05Z',
        endedAt: '2026-11-05T23:01:07Z',
      },
      { step: 'start', state: 'pending', startedAt: null, endedAt: null },
    ];
    const result = {
      ok: false,
      from: '0.9.0',
      to: '0.9.1',
      at: '2026-11-05T23:01:30Z',
      step: 'migrate',
      detail: 'division by zero The database was not changed.',
      databasePutBack: false,
      backup: 'C:\\ProgramData\\ARTEPOOL\\backups\\pre-upgrade\\x.dump',
      steps,
      statusPage: {
        pid: 4242,
        startedAt: '2026-11-05T23:00:25Z',
        stoppedAt: '2026-11-05T23:01:08Z',
        stopReason: 'asked',
        answers: { status: 40, refused: 2, limited: 0 },
        error: null,
      },
    };
    await updaterState(`last_result = '${JSON.stringify(result).replace(/'/g, "''")}'`);
    expect((await get()).json<UpdateStatus>().lastResult).toEqual({
      ok: false,
      from: '0.9.0',
      to: '0.9.1',
      at: '2026-11-05T23:01:30Z',
      step: 'migrate',
      detail: 'division by zero The database was not changed.',
      databasePutBack: false,
      steps,
      statusPage: {
        startedAt: '2026-11-05T23:00:25Z',
        stoppedAt: '2026-11-05T23:01:08Z',
        stopReason: 'asked',
      },
    });
    // A result from before 0.9.0 has no steps; one that is not a result shows nothing.
    await updaterState(
      `last_result = '{"ok": true, "from": "0.7.0", "to": "0.8.0", "at": "2026-11-02T06:30:00Z"}'`,
    );
    expect((await get()).json<UpdateStatus>().lastResult).toEqual({
      ok: true,
      from: '0.7.0',
      to: '0.8.0',
      at: '2026-11-02T06:30:00Z',
    });
    await updaterState(`last_result = '{"what": "else"}'`);
    expect((await get()).json<UpdateStatus>().lastResult).toBeNull();
  });

  it("tells an enrolled PC the server's version, and nobody else (0115)", async () => {
    const answer = await call(server, 'GET', '/api/v1/system/version', { device: office });
    expect(answer.statusCode).toBe(200);
    expect(answer.json<{ version: string }>().version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(answer.json<object>())).toEqual(['version']);
    expect(errorCode(await call(server, 'GET', '/api/v1/system/version', {}))).toMatch(/DEVICE/);
  });
});
