/**
 * T5: enrolled PCs (decisions 0024–0026). The enrollment protocol is played here exactly as the
 * desktop app will play it, including checking that the server is genuine.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clientProofMessage,
  enrollTranscript,
  serverProofMessage,
  type DeviceKind,
  type DevicesResponse,
  type EnrollCompleteResponse,
  type EnrollHelloResponse,
  type EnrollmentCodeResponse,
  type RenewKeyResponse,
  type ThisDeviceResponse,
} from '@artepool/shared/contracts';
import { buildApp } from '../../src/app';
import {
  ConsoleError,
  createConsoleCode,
  createFirstOwner,
  resetOwnerTwoStep,
} from '../../src/cli/bootstrap';
import { SecretBox } from '../../src/platform/crypto/secret-box';
import { newToken, sha256 } from '../../src/platform/crypto/tokens';
import { createDeps } from '../../src/platform/http/deps';
import { caFingerprint, deriveCodeKey, proof } from '../../src/modules/devices/enrollment-crypto';
import {
  addDevice,
  addOwner,
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
let office: TestDevice;
let ownerId: bigint;
let ownerToken: string;

beforeAll(async () => {
  server = await startTestServer();
  office = await addDevice(server, { code: 'OFFICE-01' });
  ownerId = await addOwner(server);
  ownerToken = (
    await openSession(server, { userId: ownerId, deviceId: office.id, method: 'password_totp' })
  ).token;
});
afterAll(() => server.close());

const asOwner = { device: () => office, token: () => ownerToken };

async function newCode(): Promise<EnrollmentCodeResponse> {
  const response = await call(server, 'POST', '/api/v1/devices/enrollment-codes', {
    device: asOwner.device(),
    token: asOwner.token(),
    idempotencyKey: randomUUID(),
  });
  expect(response.statusCode).toBe(201);
  return response.json<EnrollmentCodeResponse>();
}

interface PcOptions {
  deviceCode: string;
  kind?: DeviceKind;
  name?: string;
  remoteAddress?: string;
  /** Use a wrong code on purpose. */
  typedCode?: string;
}

/** Plays the desktop side of enrollment v1. */
async function enrollPc(code: string, options: PcOptions) {
  const clientNonce = randomBytes(32).toString('base64url');
  const net = options.remoteAddress ? { remoteAddress: options.remoteAddress } : {};
  const hello = await call(server, 'POST', '/api/v1/enroll/hello', {
    ...net,
    body: { clientNonce },
  });
  const h = hello.json<EnrollHelloResponse>();
  const codeKey = await deriveCodeKey(
    options.typedCode ?? code,
    Buffer.from(h.keySalt, 'base64url'),
  );
  const transcript = enrollTranscript(
    clientNonce,
    h.serverNonce,
    caFingerprint(h.caCertificatePem),
  );
  const serverIsGenuine = proof(codeKey, serverProofMessage(transcript)) === h.serverProof;
  const deviceKey = newToken();
  const device = {
    deviceCode: options.deviceCode,
    deviceName: options.name ?? 'Showroom counter',
    deviceKind: options.kind ?? 'pos',
    deviceKeyHash: sha256(deviceKey).toString('base64url'),
  };
  const complete = await call(server, 'POST', '/api/v1/enroll/complete', {
    ...net,
    body: {
      clientNonce,
      serverNonce: h.serverNonce,
      ...device,
      clientProof: proof(codeKey, clientProofMessage(transcript, device)),
    },
  });
  return { hello: h, serverIsGenuine, complete, device: { id: 0n, key: deviceKey } };
}

describe('enrollment codes in Settings → Devices', () => {
  it('shows a new code once; a retry of the same request does not show it again', async () => {
    const key = randomUUID();
    const send = () =>
      call(server, 'POST', '/api/v1/devices/enrollment-codes', {
        device: office,
        token: ownerToken,
        idempotencyKey: key,
      });
    const first = (await send()).json<EnrollmentCodeResponse>();
    expect(first.code).toMatch(/^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/);
    const minutes = (Date.parse(first.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
    const again = (await send()).json<EnrollmentCodeResponse>();
    expect(again).toEqual({ code: null, expiresAt: first.expiresAt });
    const list = (
      await call(server, 'GET', '/api/v1/devices', { device: office, token: ownerToken })
    ).json<DevicesResponse>();
    expect(list.openCode).toEqual({ expiresAt: first.expiresAt });
    const stored = await server.db.selectFrom('auth.enrollment_codes').select('code_key').execute();
    expect(JSON.stringify(stored)).not.toContain(first.code!.replaceAll('-', ''));
  });

  it('is owner-only, checked on the server', async () => {
    const accountant = await addUser(server, { username: 'khaled.acc', roles: ['accountant'] });
    const token = (await openSession(server, { userId: accountant, deviceId: office.id })).token;
    const response = await call(server, 'POST', '/api/v1/devices/enrollment-codes', {
      device: office,
      token,
      idempotencyKey: randomUUID(),
    });
    expect(errorCode(response)).toBe('PERMISSION_DENIED');
    expect(errorCode(await call(server, 'GET', '/api/v1/devices', { device: office, token }))).toBe(
      'PERMISSION_DENIED',
    );
  });
});

describe('enrolling a PC (decision 0024)', () => {
  it('lets the PC check the server is genuine, then stores only the hash of its own key', async () => {
    const { code } = await newCode();
    const result = await enrollPc(code!, { deviceCode: 'COUNTER-02', name: 'الكاشير 2' });
    expect(result.hello.caCertificatePem).toContain('TEST-ARTEPOOL-CA');
    expect(result.serverIsGenuine).toBe(true);
    expect(result.complete.statusCode).toBe(201);
    const enrolled = result.complete.json<EnrollCompleteResponse>();
    expect(enrolled.device).toMatchObject({ code: 'COUNTER-02', name: 'الكاشير 2', kind: 'pos' });
    expect(JSON.stringify(enrolled)).not.toContain(result.device.key);
    // The new key opens the door for device-level requests.
    const pinUsers = await call(server, 'GET', '/api/v1/auth/pin-users', {
      device: result.device.key,
    });
    expect(pinUsers.statusCode).toBe(200);
    const row = await server.db
      .selectFrom('auth.devices')
      .select(['key_hash', 'enrolled_by'])
      .where('code', '=', 'COUNTER-02')
      .executeTakeFirstOrThrow();
    expect(row.key_hash.equals(sha256(result.device.key))).toBe(true);
    expect(row.enrolled_by).toBe(ownerId);
    // The code is used up.
    const reuse = await enrollPc(code!, { deviceCode: 'COUNTER-03' });
    expect(errorCode(reuse.complete)).toBe('ENROLLMENT_FAILED');
  });

  it('a wrong code fails on both sides, and 5 wrong tries cancel the code', async () => {
    const { code } = await newCode();
    const wrong = await enrollPc(code!, { deviceCode: 'BAD-PC', typedCode: 'AAA-BBB-CCC' });
    expect(wrong.serverIsGenuine).toBe(false); // the PC would stop here and warn
    expect(errorCode(wrong.complete)).toBe('ENROLLMENT_FAILED');
    for (let i = 0; i < 4; i++) {
      await enrollPc(code!, {
        deviceCode: 'BAD-PC',
        typedCode: 'AAA-BBB-CCC',
        remoteAddress: `10.0.1.${i}`,
      });
    }
    const right = await enrollPc(code!, { deviceCode: 'GOOD-PC', remoteAddress: '10.0.1.9' });
    expect(errorCode(right.complete)).toBe('ENROLLMENT_FAILED');
    const cancelled = await server.db
      .selectFrom('auth.enrollment_codes')
      .select('cancel_reason')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(cancelled.cancel_reason).toBe('too_many_attempts');
  });

  it('gives a look-alike answer when no code is open, so nobody learns whether one is', async () => {
    const result = await enrollPc('ZZZ-ZZZ-ZZZ', {
      deviceCode: 'NO-CODE-PC',
      remoteAddress: '10.0.2.1',
    });
    expect(result.hello.serverProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.hello.keySalt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(result.serverIsGenuine).toBe(false);
    expect(errorCode(result.complete)).toBe('ENROLLMENT_FAILED');
  });

  it('refuses an expired code', async () => {
    const { code } = await newCode();
    await ageRow(
      server,
      `UPDATE auth.enrollment_codes SET created_at = now() - interval '20 minutes',
              expires_at = now() - interval '10 minutes' WHERE used_at IS NULL AND cancelled_at IS NULL`,
      [],
    );
    const late = await enrollPc(code!, { deviceCode: 'LATE-PC', remoteAddress: '10.0.3.1' });
    expect(errorCode(late.complete)).toBe('ENROLLMENT_FAILED');
  });

  it('keeps the code when the PC name is already taken, so a retry with another name works', async () => {
    const { code } = await newCode();
    const taken = await enrollPc(code!, { deviceCode: 'office-01', remoteAddress: '10.0.4.1' });
    expect(errorCode(taken.complete)).toBe('DUPLICATE');
    const retry = await enrollPc(code!, {
      deviceCode: 'OFFICE-02',
      kind: 'office',
      remoteAddress: '10.0.4.1',
    });
    expect(retry.complete.statusCode).toBe(201);
  });

  it('slows down anyone hammering enrollment from one address', async () => {
    for (let i = 0; i < 10; i++) {
      await call(server, 'POST', '/api/v1/enroll/hello', {
        remoteAddress: '10.0.5.5',
        body: { clientNonce: randomBytes(32).toString('base64url') },
      });
    }
    const blocked = await call(server, 'POST', '/api/v1/enroll/hello', {
      remoteAddress: '10.0.5.5',
      body: { clientNonce: randomBytes(32).toString('base64url') },
    });
    expect(errorCode(blocked)).toBe('RATE_LIMITED');
  });

  it('is unavailable until the secure connection is set up', async () => {
    const app = buildApp(
      { logLevel: 'silent' },
      createDeps({ db: server.db, secretBox: SecretBox.fromKey(Buffer.alloc(32, 3)) }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/enroll/hello',
      payload: { clientNonce: randomBytes(32).toString('base64url') },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'ENROLLMENT_UNAVAILABLE' } });
    await app.close();
  });
});

describe('this PC', () => {
  it('tells an enrolled PC its own name, code, kind and key date, and nobody else', async () => {
    const pc = await addDevice(server, { code: 'SELF-PC', kind: 'pos' });
    const response = await call(server, 'GET', '/api/v1/devices/me', { device: pc });
    expect(response.statusCode).toBe(200);
    const body = response.json<ThisDeviceResponse>();
    expect(body.device).toEqual({
      id: pc.id.toString(),
      code: 'SELF-PC',
      name: 'Test PC',
      kind: 'pos',
    });
    expect(Date.parse(body.keyExpiresAt)).toBeGreaterThan(Date.now());
    expect(errorCode(await call(server, 'GET', '/api/v1/devices/me', {}))).toBe(
      'DEVICE_NOT_ENROLLED',
    );
  });
});

describe('device keys renew themselves', () => {
  it('renews only near expiry; the old key stops working at once', async () => {
    const pc = await addDevice(server, { code: 'RENEW-PC' });
    const fresh = sha256(newToken()).toString('base64url');
    const early = await call(server, 'POST', '/api/v1/devices/me/renew-key', {
      device: pc,
      body: { newKeyHash: fresh },
    });
    expect(early.json<RenewKeyResponse>().renewed).toBe(false);

    await ageRow(
      server,
      `UPDATE auth.devices SET enrolled_at = now() - interval '355 days',
              key_expires_at = now() + interval '10 days' WHERE id = $1`,
      [pc.id.toString()],
    );
    const newKey = newToken();
    const renewed = await call(server, 'POST', '/api/v1/devices/me/renew-key', {
      device: pc,
      body: { newKeyHash: sha256(newKey).toString('base64url') },
    });
    const body = renewed.json<RenewKeyResponse>();
    expect(body.renewed).toBe(true);
    expect(Date.parse(body.keyExpiresAt) - Date.now()).toBeGreaterThan(360 * 86_400_000);
    expect(errorCode(await call(server, 'GET', '/api/v1/auth/pin-users', { device: pc }))).toBe(
      'DEVICE_NOT_ENROLLED',
    );
    expect(
      (await call(server, 'GET', '/api/v1/auth/pin-users', { device: newKey })).statusCode,
    ).toBe(200);
  });
});

describe('revoking a PC (decision 0026)', () => {
  const revoke = (id: bigint, body: unknown) =>
    call(server, 'POST', `/api/v1/devices/${id}/revoke`, {
      device: office,
      token: ownerToken,
      idempotencyKey: randomUUID(),
      body,
    });

  it('needs a reason, ends the PC sessions at once and refuses it from then on', async () => {
    const counter = await addDevice(server, { code: 'COUNTER-09', kind: 'pos' });
    const cashier = await addUser(server, {
      username: 'sara.cashier',
      method: 'pin',
      roles: ['cashier'],
    });
    const session = await openSession(server, {
      userId: cashier,
      deviceId: counter.id,
      method: 'pin',
    });
    expect(errorCode(await revoke(counter.id, { reason: '' }))).toBe('VALIDATION_FAILED');
    const done = await revoke(counter.id, { reason: 'Old laptop sold' });
    expect(done.statusCode).toBe(200);
    const after = await call(server, 'GET', '/api/v1/auth/me', {
      device: counter,
      token: session.token,
    });
    expect(after.statusCode).toBe(403);
    expect(errorCode(after)).toBe('DEVICE_REVOKED');
    const ended = await server.db
      .selectFrom('auth.sessions')
      .select('end_reason')
      .where('id', '=', session.id)
      .executeTakeFirstOrThrow();
    expect(ended.end_reason).toBe('device_revoked');
    const audit = await server.db
      .selectFrom('audit.log')
      .select(['user_id', 'reason', 'new_values'])
      .where('entity_type', '=', 'auth.devices')
      .where('entity_id', '=', counter.id.toString())
      .where('action', '=', 'update')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      user_id: ownerId,
      reason: 'Old laptop sold',
      new_values: { status: 'revoked', revoke_reason: 'Old laptop sold' },
    });
    expect(errorCode(await revoke(counter.id, { reason: 'again' }))).toBe('ROW_IMMUTABLE');
  });

  it('cannot revoke the server or the PC being used', async () => {
    const serverPc = await addDevice(server, { code: 'SERVER-01', kind: 'server' });
    expect(errorCode(await revoke(serverPc.id, { reason: 'testing' }))).toBe('DEVICE_PROTECTED');
    expect(errorCode(await revoke(office.id, { reason: 'testing' }))).toBe('DEVICE_PROTECTED');
  });

  it('renames a PC and changes its type, audited', async () => {
    const pc = await addDevice(server, { code: 'STORE-01', kind: 'office' });
    const response = await call(server, 'PATCH', `/api/v1/devices/${pc.id}`, {
      device: office,
      token: ownerToken,
      idempotencyKey: randomUUID(),
      body: { name: 'Warehouse PC', kind: 'warehouse' },
    });
    expect(response.statusCode).toBe(200);
    const list = (
      await call(server, 'GET', '/api/v1/devices', { device: office, token: ownerToken })
    ).json<DevicesResponse>();
    expect(list.devices.find((d) => d.code === 'STORE-01')).toMatchObject({
      name: 'Warehouse PC',
      kind: 'warehouse',
    });
    expect(list.devices.find((d) => d.code === 'OFFICE-01')?.isCurrent).toBe(true);
    expect(list.devices.find((d) => d.code === 'OFFICE-01')?.lastSeenAt).not.toBeNull();
  });
});

describe('server-console commands (decision 0025)', () => {
  it('device:code makes a code that enrolls a PC', async () => {
    const { code } = await createConsoleCode(server.db, server.deps.settings);
    const pc = await enrollPc(code, {
      deviceCode: 'FIRST-PC',
      kind: 'office',
      remoteAddress: '10.0.6.1',
    });
    expect(pc.complete.statusCode).toBe(201);
    const row = await server.db
      .selectFrom('auth.enrollment_codes')
      .select(['origin', 'used_device_id'])
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(row.origin).toBe('console');
    expect(row.used_device_id).not.toBeNull();
  });

  it('owner:reset-2fa clears the 2-step setup, retires recovery codes and ends sessions', async () => {
    await expect(resetOwnerTwoStep(server.db, ' ')).rejects.toThrow(ConsoleError);
    const live = await openSession(server, {
      userId: ownerId,
      deviceId: office.id,
      method: 'password_totp',
    });
    const username = await resetOwnerTwoStep(server.db, 'Phone and codes lost');
    expect(username).toBe('owner.main');
    const user = await server.db
      .selectFrom('auth.users')
      .select(['totp_enabled', 'totp_secret_enc'])
      .where('id', '=', ownerId)
      .executeTakeFirstOrThrow();
    expect(user).toEqual({ totp_enabled: false, totp_secret_enc: null });
    expect(
      errorCode(
        await call(server, 'GET', '/api/v1/auth/me', { device: office, token: live.token }),
      ),
    ).toBe('SESSION_EXPIRED');
    const event = await server.db
      .selectFrom('audit.log')
      .select(['user_id', 'reason'])
      .where('action', '=', 'event:auth.owner_two_step_reset')
      .executeTakeFirstOrThrow();
    expect(event).toEqual({ user_id: 1n, reason: 'Phone and codes lost' });
  });

  it('owner:create works only while there is no active owner, with the password rules', async () => {
    const fresh = await startTestServer();
    try {
      const input = {
        username: 'mohammed',
        displayNameAr: 'محمد ياسر',
        displayNameEn: 'Mohammed Yasser',
      };
      await expect(
        createFirstOwner(fresh.db, fresh.deps.hasher, fresh.deps.settings, {
          ...input,
          password: 'short',
        }),
      ).rejects.toThrow(/at least 10 characters/);
      await expect(
        createFirstOwner(fresh.db, fresh.deps.hasher, fresh.deps.settings, {
          ...input,
          username: 'Bad Name',
          password: 'a strong passphrase',
        }),
      ).rejects.toThrow(/username/);
      const id = await createFirstOwner(fresh.db, fresh.deps.hasher, fresh.deps.settings, {
        ...input,
        password: 'a strong passphrase',
      });
      const user = await fresh.db
        .selectFrom('auth.users')
        .select(['sign_in_method', 'must_change_password', 'totp_enabled'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(user).toEqual({
        sign_in_method: 'password_totp',
        must_change_password: false,
        totp_enabled: false,
      });
      await expect(
        createFirstOwner(fresh.db, fresh.deps.hasher, fresh.deps.settings, {
          ...input,
          username: 'second.owner',
          password: 'another strong one',
        }),
      ).rejects.toThrow(/already exists/);
    } finally {
      await fresh.close();
    }
  });
});
