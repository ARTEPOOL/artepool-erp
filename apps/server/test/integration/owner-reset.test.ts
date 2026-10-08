/**
 * Decision 0029: `pnpm owner:reset-password` on the server PC — a temporary password shown once,
 * every owner session and trusted PC ended, optionally the 2-step setup cleared, the reason kept
 * in the audit log, and a notice on the owner's next "Choose your own password" screen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MeResponse, SessionView, SignInResponse } from '@artepool/shared/contracts';
import { ConsoleError, resetOwnerPassword } from '../../src/cli/bootstrap';
import { totpCode } from '../../src/platform/auth/totp';
import { RateLimiter } from '../../src/platform/http/rate-limit';
import { addOwnerWithTwoStep } from '../support/https';
import {
  addDevice,
  ageRow,
  call,
  errorCode,
  startTestServer,
  type TestDevice,
  type TestServer,
} from '../support/server';

let server: TestServer;
let office: TestDevice;
let laptop: TestDevice;
let owner: { id: bigint; secret: string };
const username = 'mohammed';
let password = 'the-owner-first-password';
/** Every secret used in this file; none may appear in any log or audit entry. */
const secrets: string[] = [password];

beforeAll(async () => {
  server = await startTestServer(undefined, {
    limits: {
      unknownDevice: new RateLimiter(1000, 60_000),
      signIn: new RateLimiter(1000, 60_000),
      enrollment: new RateLimiter(1000, 60_000),
    },
  });
  owner = await addOwnerWithTwoStep(server, {
    username,
    password,
    recoveryCodes: ['ABCDE-FGHJK', 'MNPQR-STUVW'],
  });
  office = await addDevice(server, { code: 'OFFICE-01' });
  laptop = await addDevice(server, { code: 'LAPTOP-01' });
  secrets.push(owner.secret, office.key, laptop.key);
});
afterAll(() => server.close());

const signIn = (device: TestDevice, secret = password) =>
  call(server, 'POST', '/api/v1/auth/sign-in', { device, body: { username, password: secret } });

async function freshCode(): Promise<string> {
  await ageRow(server, 'UPDATE auth.users SET totp_last_step = NULL WHERE id = $1', [
    owner.id.toString(),
  ]);
  return totpCode(owner.secret);
}

async function secondFactor(
  device: TestDevice,
  token: string,
  trustDevice = false,
): Promise<SignInResponse> {
  const response = await call(server, 'POST', '/api/v1/auth/second-factor', {
    device,
    token,
    body: { code: await freshCode(), ...(trustDevice ? { trustDevice } : {}) },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<SignInResponse>();
  secrets.push(body.token);
  return body;
}

const json = <T>(response: { json: <U>() => U }) => response.json<T>();

describe('emergency owner password reset on the server PC (decision 0029)', () => {
  it('needs a reason, and changes nothing without one', async () => {
    await expect(
      resetOwnerPassword(server.db, server.deps.hasher, { reason: ' ', phoneLost: false }),
    ).rejects.toThrow(ConsoleError);
    const first = json<SignInResponse>(await signIn(office));
    secrets.push(first.token);
    expect(first.session.stage).toBe('second_factor');
  });

  it('phone kept: a temporary password, then the code, then the owner chooses their own', async () => {
    // Before: signed in on the laptop, the office PC trusted, the account locked.
    const waiting = json<SignInResponse>(await signIn(laptop));
    secrets.push(waiting.token);
    const elsewhere = await secondFactor(laptop, waiting.token);
    const atOffice = json<SignInResponse>(await signIn(office));
    secrets.push(atOffice.token);
    await secondFactor(office, atOffice.token, true);
    for (let i = 0; i < 5; i++) await signIn(office, `wrong-password-${i}x`);
    expect(errorCode(await signIn(office))).toBe('ACCOUNT_LOCKED');

    const reason = 'Password and recovery codes lost';
    const result = await resetOwnerPassword(server.db, server.deps.hasher, {
      reason,
      phoneLost: false,
    });
    secrets.push(result.temporaryPassword);
    expect(result.username).toBe(username);
    expect(result.temporaryPassword).toMatch(
      /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/,
    );

    // Everything that relied on the old password ended.
    expect(
      errorCode(
        await call(server, 'GET', '/api/v1/auth/me', { device: laptop, token: elsewhere.token }),
      ),
    ).toBe('SESSION_EXPIRED');
    const trusts = await server.db
      .selectFrom('auth.device_trust')
      .select('end_reason')
      .where('user_id', '=', owner.id)
      .execute();
    expect(trusts).toEqual([{ end_reason: 'password_changed' }]);
    expect(errorCode(await signIn(office))).toBe('INVALID_CREDENTIALS');

    // The temporary password works (unlocked); the code is still asked; then the notice.
    const first = json<SignInResponse>(await signIn(office, result.temporaryPassword));
    secrets.push(first.token);
    expect(first.session.stage).toBe('second_factor');
    expect(first.serverReset).toEqual({ at: expect.any(String) as string, reason });
    const full = await secondFactor(office, first.token);
    expect(full.session.pending).toBe('credential_change');
    expect(full.serverReset?.reason).toBe(reason);

    password = 'the-owner-new-password';
    secrets.push(password);
    const changed = await call(server, 'POST', '/api/v1/auth/change-password', {
      device: office,
      token: full.token,
      body: { currentPassword: result.temporaryPassword, newPassword: password },
    });
    expect(changed.statusCode).toBe(200);
    expect(json<SessionView>(changed).pending).toBeNull();
    const after = json<SignInResponse>(await signIn(office));
    secrets.push(after.token);
    expect(after.serverReset).toBeUndefined();

    const events = await server.db
      .selectFrom('audit.log')
      .select(['user_id', 'reason', 'new_values'])
      .where('action', '=', 'event:auth.owner_password_reset')
      .execute();
    expect(events).toEqual([{ user_id: 1n, reason, new_values: { twoStepCleared: false } }]);
  });

  it('phone lost too: the 2-step setup and the old recovery codes are cleared', async () => {
    const result = await resetOwnerPassword(server.db, server.deps.hasher, {
      reason: 'Phone, codes and password all lost',
      phoneLost: true,
    });
    secrets.push(result.temporaryPassword);
    const session = json<SignInResponse>(await signIn(office, result.temporaryPassword));
    secrets.push(session.token);
    expect(session.session).toMatchObject({ stage: 'full', pending: 'credential_change' });
    expect(session.serverReset?.reason).toBe('Phone, codes and password all lost');

    password = 'the-owner-third-password';
    secrets.push(password);
    await call(server, 'POST', '/api/v1/auth/change-password', {
      device: office,
      token: session.token,
      body: { currentPassword: result.temporaryPassword, newPassword: password },
    });
    const me = json<MeResponse>(
      await call(server, 'GET', '/api/v1/auth/me', { device: office, token: session.token }),
    );
    expect(me.session.pending).toBe('two_step_setup');
    const unused = await server.db
      .selectFrom('auth.recovery_codes')
      .select('id')
      .where('user_id', '=', owner.id)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute();
    expect(unused).toEqual([]);
  });

  it('never writes a secret to the logs or the audit log', async () => {
    const audit = await server.db
      .selectFrom('audit.log')
      .select(['old_values', 'new_values', 'reason'])
      .execute();
    const everything = JSON.stringify([...server.logs, ...audit], (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    for (const secret of secrets) expect(everything).not.toContain(secret);
  });
});
