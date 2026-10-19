/**
 * The POS kiosk lock (decisions 0082, 0083, 0089): kept on the server, on unless the owner turned
 * it off; only the owner, with a reason and a fresh 2-step code; the lock screen's owner code
 * lifts it for 15 minutes with limited tries (0091); while the owner is signed in on the PC the
 * lock is off; every change and exit attempt is audited
 * and alerts the owner.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DevicesResponse,
  KioskAlertsResponse,
  KioskLock,
  KioskStateResponse,
} from '@artepool/shared/contracts';
import { totpCode } from '../../src/platform/auth/totp';
import { withBusinessTx } from '../../src/platform/db/tx';
import { addOwnerWithTwoStep } from '../support/https';
import {
  addDevice,
  addUser,
  ageRow,
  call,
  errorCode,
  openSession,
  startTestServer,
  type TestDevice,
  type TestServer,
} from '../support/server';

let server: TestServer;
let pos: TestDevice;
let office: TestDevice;
let owner: bigint;
let ownerSecret: string;
let ownerToken: string;
let accountantToken: string;

beforeAll(async () => {
  server = await startTestServer();
  pos = await addDevice(server, { code: 'COUNTER-01', kind: 'pos' });
  office = await addDevice(server, { code: 'OFFICE-01', kind: 'office' });
  const o = await addOwnerWithTwoStep(server, { username: 'owner.main' });
  owner = o.id;
  ownerSecret = o.secret;
  ownerToken = (
    await openSession(server, { userId: owner, deviceId: office.id, method: 'password_totp' })
  ).token;
  const accountant = await addUser(server, { username: 'khaled.acc', roles: ['accountant'] });
  accountantToken = (await openSession(server, { userId: accountant, deviceId: office.id })).token;
});
afterAll(() => server.close());

/** The owner's current code, as the phone shows it; each code works once. */
async function code(): Promise<string> {
  await ageRow(server, `UPDATE auth.users SET totp_last_step = NULL WHERE id = $1`, [owner]);
  return totpCode(ownerSecret, Date.now());
}

const state = async (device: TestDevice) =>
  (await call(server, 'GET', '/api/v1/kiosk/state', { device })).json<KioskStateResponse>();

const setLock = (deviceId: bigint, body: Record<string, unknown>, token = ownerToken) =>
  call(server, 'POST', `/api/v1/devices/${deviceId}/kiosk-lock`, {
    device: office,
    token,
    idempotencyKey: randomUUID(),
    body,
  });

const unlockWithCode = (value: string) =>
  call(server, 'POST', '/api/v1/kiosk/unlock-with-code', { device: pos, body: { code: value } });

const alerts = (type: string) =>
  server.db
    .selectFrom('sys.alerts')
    .select(['id', 'params', 'acknowledged_at'])
    .where('alert_type', '=', type)
    .where('entity_id', '=', pos.id.toString())
    .orderBy('id')
    .execute();

/** Ends any "off" so each test starts with the lock on. */
async function lockOn(): Promise<void> {
  const response = await setLock(pos.id, {
    on: true,
    reason: 'Back to normal',
    code: await code(),
  });
  expect(response.statusCode).toBe(200);
}

describe('kiosk lock', () => {
  it('is on by default on a POS PC; other PCs have none', async () => {
    expect(await state(pos)).toEqual({
      isPos: true,
      locked: true,
      switchedOff: false,
      offUntil: null,
      ownerSignedIn: false,
    });
    expect(await state(office)).toEqual({
      isPos: false,
      locked: false,
      switchedOff: false,
      offUntil: null,
      ownerSignedIn: false,
    });
  });

  it('is turned off by the owner only, with a reason and a fresh 2-step code', async () => {
    expect(
      errorCode(
        await setLock(pos.id, { on: false, reason: 'Printer', code: '123456' }, accountantToken),
      ),
    ).toBe('PERMISSION_DENIED');
    expect(errorCode(await setLock(pos.id, { on: false, code: await code() }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(errorCode(await setLock(pos.id, { on: false, reason: 'Printer', code: '000000' }))).toBe(
      'INVALID_TWO_STEP_CODE',
    );
    expect(
      errorCode(await setLock(office.id, { on: false, reason: 'Printer', code: await code() })),
    ).toBe('VALIDATION_FAILED');
    expect((await state(pos)).locked).toBe(true);

    const now = await code();
    const off = await setLock(pos.id, {
      on: false,
      minutes: 15,
      reason: 'Printer driver',
      code: now,
    });
    expect(off.statusCode).toBe(200);
    const lock = off.json<KioskLock>();
    expect(lock.locked).toBe(false);
    const minutes = (Date.parse(lock.offUntil!) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14.5);
    expect(minutes).toBeLessThanOrEqual(15);
    expect(await state(pos)).toEqual({ isPos: true, ...lock });
    // The same code never works twice.
    expect(errorCode(await setLock(pos.id, { on: true, reason: 'Again', code: now }))).toBe(
      'INVALID_TWO_STEP_CODE',
    );

    const audit = await server.db
      .selectFrom('audit.log')
      .select(['user_id', 'reason'])
      .where('entity_type', '=', 'auth.kiosk_lock_changes')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ user_id: owner, reason: 'Printer driver' });
    const raised = await alerts('kiosk_lock_off');
    expect(raised.at(-1)!.params).toMatchObject({
      code: 'COUNTER-01',
      minutes: 15,
      via: 'settings',
    });

    await lockOn();
    expect(await state(pos)).toEqual({
      isPos: true,
      locked: true,
      switchedOff: false,
      offUntil: null,
      ownerSignedIn: false,
    });
    expect((await alerts('kiosk_lock_on')).length).toBeGreaterThan(0);
  });

  it('can stay off until the owner turns it back on', async () => {
    const off = await setLock(pos.id, { on: false, reason: 'Windows update', code: await code() });
    expect(off.json<KioskLock>()).toEqual({
      locked: false,
      switchedOff: true,
      offUntil: null,
      ownerSignedIn: false,
    });
    const listed = (
      await call(server, 'GET', '/api/v1/devices', { device: office, token: ownerToken })
    ).json<DevicesResponse>();
    expect(listed.devices.find((d) => d.code === 'COUNTER-01')!.kioskLock).toEqual({
      locked: false,
      switchedOff: true,
      offUntil: null,
      ownerSignedIn: false,
    });
    expect(listed.devices.find((d) => d.code === 'OFFICE-01')!.kioskLock).toBeNull();
    await lockOn();
  });

  it('comes back on by itself when the time runs out, with one alert', async () => {
    await setLock(pos.id, { on: false, minutes: 60, reason: 'Maintenance', code: await code() });
    const before = (await alerts('kiosk_lock_on')).length;
    await ageRow(
      server,
      `UPDATE auth.kiosk_lock_changes SET off_until = now() - interval '1 second'
        WHERE id = (SELECT max(id) FROM auth.kiosk_lock_changes)`,
      [],
    );
    expect(await state(pos)).toEqual({
      isPos: true,
      locked: true,
      switchedOff: false,
      offUntil: null,
      ownerSignedIn: false,
    });
    await state(pos);
    const after = await alerts('kiosk_lock_on');
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)!.params).toMatchObject({ expired: true });
    // Acknowledged, it never comes back for the same "off".
    await ageRow(
      server,
      `UPDATE sys.alerts SET acknowledged_at = now(), acknowledged_by = 1 WHERE id = $1`,
      [after.at(-1)!.id],
    );
    await state(pos);
    expect(await alerts('kiosk_lock_on')).toHaveLength(after.length);
  });

  it('lifts for 15 minutes with the owner code on the lock screen, once per code', async () => {
    const now = await code();
    const response = await unlockWithCode(now);
    expect(response.statusCode).toBe(200);
    const lock = response.json<KioskLock>();
    expect(lock.locked).toBe(false);
    const left = (Date.parse(lock.offUntil!) - Date.now()) / 60_000;
    expect(left).toBeGreaterThan(14.5);
    expect(left).toBeLessThanOrEqual(15);
    const row = await server.db
      .selectFrom('auth.kiosk_lock_changes')
      .select(['via', 'created_by', 'reason'])
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ via: 'owner_code', created_by: owner, reason: null });
    expect((await alerts('kiosk_lock_off')).at(-1)!.params).toMatchObject({ via: 'owner_code' });
    expect(errorCode(await unlockWithCode(now))).toBe('INVALID_TWO_STEP_CODE');
    await lockOn();
  });

  it('closes the owner-code door after 5 wrong codes in 15 minutes', async () => {
    // The reused code of the test above was a wrong try too: move it out of the window.
    const forget = () =>
      ageRow(
        server,
        `UPDATE auth.kiosk_code_failures SET created_at = created_at - interval '16 minutes'`,
        [],
      );
    await forget();
    for (let i = 0; i < 5; i++) {
      expect(errorCode(await unlockWithCode('000000'))).toBe('INVALID_TWO_STEP_CODE');
    }
    expect(errorCode(await unlockWithCode(await code()))).toBe('KIOSK_CODE_BLOCKED');
    expect(await alerts('kiosk_code_blocked')).toHaveLength(1);
    expect((await state(pos)).locked).toBe(true);
    const failed = await server.db
      .selectFrom('audit.log')
      .select('id')
      .where('action', '=', 'event:kiosk.owner_code_failed')
      .execute();
    expect(failed).toHaveLength(6);
    // 15 minutes later the door opens again.
    await forget();
    expect((await unlockWithCode(await code())).statusCode).toBe(200);
    await lockOn();
  });

  it('records attempts to leave the app and alerts the owner', async () => {
    const response = await call(server, 'POST', '/api/v1/kiosk/events', {
      device: pos,
      body: { kind: 'close_refused' },
    });
    expect(response.statusCode).toBe(200);
    const event = await server.db
      .selectFrom('audit.log')
      .select(['entity_id', 'new_values'])
      .where('action', '=', 'event:kiosk.exit_attempt')
      .executeTakeFirstOrThrow();
    expect(event.entity_id).toBe(pos.id.toString());
    expect((await alerts('kiosk_exit_attempt'))[0]!.params).toMatchObject({
      kind: 'close_refused',
    });
    // An office PC has no kiosk: nothing is recorded.
    await call(server, 'POST', '/api/v1/kiosk/events', {
      device: office,
      body: { kind: 'restarted' },
    });
    expect(
      await server.db
        .selectFrom('audit.log')
        .select('id')
        .where('action', '=', 'event:kiosk.exit_attempt')
        .execute(),
    ).toHaveLength(1);
  });

  it('shows the kiosk alerts to the owner only', async () => {
    const mine = await call(server, 'GET', '/api/v1/kiosk/alerts', {
      device: office,
      token: ownerToken,
    });
    const { alerts: list } = mine.json<KioskAlertsResponse>();
    expect(list.length).toBeGreaterThan(3);
    expect(list[0]).toMatchObject({ deviceCode: 'COUNTER-01', deviceName: 'Test PC' });
    expect(
      errorCode(
        await call(server, 'GET', '/api/v1/kiosk/alerts', {
          device: office,
          token: accountantToken,
        }),
      ),
    ).toBe('PERMISSION_DENIED');
  });

  it('is off while the owner is signed in on the POS PC, and back on after sign-out or lock (0091)', async () => {
    const cashier = await addUser(server, {
      username: 'sara.cashier',
      method: 'pin',
      roles: ['cashier'],
    });
    await openSession(server, { userId: cashier, deviceId: pos.id, method: 'pin' });
    expect((await state(pos)).locked).toBe(true);

    const session = await openSession(server, {
      userId: owner,
      deviceId: pos.id,
      method: 'password_totp',
    });
    expect(await state(pos)).toEqual({
      isPos: true,
      locked: false,
      switchedOff: false,
      offUntil: null,
      ownerSignedIn: true,
    });
    // The owner locks the screen: the kiosk lock is back.
    const lockRes = await call(server, 'POST', '/api/v1/auth/lock', {
      device: pos,
      token: session.token,
    });
    expect(lockRes.statusCode).toBe(200);
    expect((await state(pos)).locked).toBe(true);
    // Unlocked again, then signed out: back on.
    await ageRow(server, `UPDATE auth.sessions SET locked_at = NULL WHERE id = $1`, [session.id]);
    expect((await state(pos)).locked).toBe(false);
    await call(server, 'POST', '/api/v1/auth/sign-out', { device: pos, token: session.token });
    expect(await state(pos)).toEqual({
      isPos: true,
      locked: true,
      switchedOff: false,
      offUntil: null,
      ownerSignedIn: false,
    });
    // The owner signed in on another PC (the office one, in beforeAll) changes nothing here.
    expect((await state(office)).locked).toBe(false);
    expect((await state(pos)).locked).toBe(true);
  });

  it('is enforced by the database: owner only, at most 15 minutes by code, never deleted', async () => {
    const accountant = await addUser(server, { username: 'other.acc', roles: ['accountant'] });
    const insert = (userId: bigint, via: string, offUntil: string) =>
      withBusinessTx(server.db, { userId, requestId: randomUUID(), reason: 'test' }, (trx) =>
        trx
          .insertInto('auth.kiosk_lock_changes')
          .values({
            device_id: pos.id,
            lock_on: false,
            off_until: new Date(Date.now() + Number(offUntil) * 60_000),
            via,
            reason: via === 'settings' ? 'Test' : null,
          } as never)
          .execute(),
      );
    await expect(insert(accountant, 'settings', '10')).rejects.toThrow(/Only the owner/);
    await expect(insert(owner, 'owner_code', '30')).rejects.toThrow(/at most 15 minutes/);
    await expect(
      withBusinessTx(server.db, { userId: owner, requestId: randomUUID(), reason: 'test' }, (trx) =>
        trx.deleteFrom('auth.kiosk_lock_changes').execute(),
      ),
    ).rejects.toThrow();
  });
});
