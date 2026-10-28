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

beforeAll(async () => {
  server = await startTestServer();
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
