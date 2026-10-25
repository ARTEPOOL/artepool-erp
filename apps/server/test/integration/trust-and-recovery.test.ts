/**
 * M1-T13: "Trust this PC" for the 2-step code (decision 0027) and forgot password with the phone
 * code and one recovery code (decision 0028) — and no secret ever reaching the logs.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DevicesResponse,
  MeResponse,
  RecoverPasswordResponse,
  SignInResponse,
} from '@artepool/shared/contracts';
import { totpCode } from '../../src/platform/auth/totp';
import { RateLimiter } from '../../src/platform/http/rate-limit';
import { addOwnerWithTwoStep } from '../support/https';
import {
  addDevice,
  addUser,
  ageRow,
  call,
  errorCode,
  startTestServer,
  type TestDevice,
  type TestServer,
} from '../support/server';

let server: TestServer;
/** Every secret used in this file; none may appear in any log or audit entry. */
const secrets: string[] = [];
const remember = <T extends string>(secret: T): T => {
  secrets.push(secret);
  return secret;
};

// Rate limits are tested elsewhere; here many sign-ins share a few PCs within a minute.
beforeAll(async () => {
  server = await startTestServer(undefined, {
    limits: {
      unknownDevice: new RateLimiter(1000, 60_000),
      signIn: new RateLimiter(1000, 60_000),
      enrollment: new RateLimiter(1000, 60_000),
    },
  });
});
afterAll(() => server.close());

interface Person {
  id: bigint;
  username: string;
  secret: string;
  password: string;
}

/** A 2-step user (the owner, or a staff member set to "password + 2-step code"). */
async function twoStepPerson(
  username: string,
  options: { owner?: boolean; recoveryCodes?: string[] } = {},
): Promise<Person> {
  const password = remember(`${username}-long-pass-phrase`);
  const { id, secret } = await addOwnerWithTwoStep(server, {
    username,
    password,
    roles: options.owner ? ['owner'] : ['accountant'],
    recoveryCodes: (options.recoveryCodes ?? []).map(remember),
  });
  remember(secret);
  return { id, username, secret, password };
}

async function pc(
  code: string,
  kind: 'pos' | 'office' | 'warehouse' = 'office',
): Promise<TestDevice> {
  const device = await addDevice(server, { code, kind });
  secrets.push(device.key);
  return device;
}

const signIn = (device: TestDevice, person: Person, password = person.password) =>
  call(server, 'POST', '/api/v1/auth/sign-in', {
    device,
    body: { username: person.username, password },
  });

/** A 6-digit code that was not used yet (the replay guard is reset for the test). */
async function freshCode(person: Person): Promise<string> {
  await ageRow(server, 'UPDATE auth.users SET totp_last_step = NULL WHERE id = $1', [
    person.id.toString(),
  ]);
  return remember(totpCode(person.secret));
}

async function fullSignIn(
  device: TestDevice,
  person: Person,
  trustDevice?: boolean,
): Promise<SignInResponse> {
  const first = (await signIn(device, person)).json<SignInResponse>();
  remember(first.token);
  if (first.session.stage === 'full') return first;
  const second = await call(server, 'POST', '/api/v1/auth/second-factor', {
    device,
    token: first.token,
    body: { code: await freshCode(person), ...(trustDevice ? { trustDevice } : {}) },
  });
  expect(second.statusCode).toBe(200);
  const full = second.json<SignInResponse>();
  remember(full.token);
  return full;
}

const trusts = (userId: bigint) =>
  server.db
    .selectFrom('auth.device_trust')
    .select(['device_id', 'end_reason'])
    .where('user_id', '=', userId)
    .orderBy('id')
    .execute();

async function events(action: string, entityId?: bigint) {
  let query = server.db
    .selectFrom('audit.log')
    .select(['user_id', 'device_id', 'new_values'])
    .where('action', '=', `event:${action}`);
  if (entityId !== undefined) query = query.where('entity_id', '=', entityId.toString());
  return query.orderBy('id').execute();
}

async function setTrustDays(days: number): Promise<void> {
  await server.admin.query('BEGIN');
  await server.admin.query(`SELECT sys.set_context(1, p_reason => 'test')`);
  await server.admin.query(
    `UPDATE sys.settings SET value = $1 WHERE key = 'security.trusted_device_days'`,
    [JSON.stringify(days)],
  );
  await server.admin.query('COMMIT');
}

describe('"Trust this PC" for the 2-step code (decision 0027)', () => {
  it('is offered on office PCs only; once ticked, the password alone works on that PC', async () => {
    const sara = await twoStepPerson('sara.trust');
    const office = await pc('SARA-PC');
    const counter = await pc('SARA-POS', 'pos');

    const first = (await signIn(office, sara)).json<SignInResponse>();
    remember(first.token);
    expect(first.session.stage).toBe('second_factor');
    expect(first.trustDays).toBe(3650);
    const onPos = (await signIn(counter, sara)).json<SignInResponse>();
    remember(onPos.token);
    expect(onPos.session.stage).toBe('second_factor');
    expect(onPos.trustDays).toBeUndefined();

    const ticked = await call(server, 'POST', '/api/v1/auth/second-factor', {
      device: office,
      token: first.token,
      body: { code: await freshCode(sara), trustDevice: true },
    });
    expect(ticked.statusCode).toBe(200);
    remember(ticked.json<SignInResponse>().token);
    expect(await trusts(sara.id)).toEqual([{ device_id: office.id, end_reason: null }]);

    const again = (await signIn(office, sara)).json<SignInResponse>();
    remember(again.token);
    expect(again.session).toMatchObject({
      stage: 'full',
      authMethod: 'trusted_device',
      pending: null,
    });
    expect(again.trustDays).toBeUndefined();
    const me = await call(server, 'GET', '/api/v1/auth/me', { device: office, token: again.token });
    expect(me.json<MeResponse>().session.authMethod).toBe('trusted_device');
    const signedIn = await events('auth.signed_in', sara.id);
    expect(signedIn.at(-1)?.new_values).toMatchObject({ method: 'trusted_device' });

    // Every other PC still asks for the phone code.
    const laptop = await pc('SARA-LAPTOP');
    const elsewhere = (await signIn(laptop, sara)).json<SignInResponse>();
    remember(elsewhere.token);
    expect(elsewhere.session.stage).toBe('second_factor');
    // A wrong password stays wrong on the trusted PC.
    expect(errorCode(await signIn(office, sara, remember('not-the-password-1')))).toBe(
      'INVALID_CREDENTIALS',
    );
  });

  it('never trusts a POS PC for anyone but the owner, and never with a recovery code', async () => {
    const omar = await twoStepPerson('omar.trust', { recoveryCodes: ['ABCDE-FGHJK'] });
    const counter = await pc('OMAR-POS', 'pos');
    await fullSignIn(counter, omar, true);
    expect(await trusts(omar.id)).toEqual([]);
    const next = (await signIn(counter, omar)).json<SignInResponse>();
    remember(next.token);
    expect(next.session.stage).toBe('second_factor');

    const office = await pc('OMAR-PC');
    const waiting = (await signIn(office, omar)).json<SignInResponse>();
    remember(waiting.token);
    const refused = await call(server, 'POST', '/api/v1/auth/second-factor', {
      device: office,
      token: waiting.token,
      body: { recoveryCode: 'ABCDE-FGHJK', trustDevice: true },
    });
    expect(errorCode(refused)).toBe('VALIDATION_FAILED');
    expect(await trusts(omar.id)).toEqual([]);
  });

  it('ends when the password changes: the phone code is asked again', async () => {
    const lina = await twoStepPerson('lina.trust');
    const office = await pc('LINA-PC');
    const session = await fullSignIn(office, lina, true);
    const newPassword = remember('lina-chose-a-new-one');
    const changed = await call(server, 'POST', '/api/v1/auth/change-password', {
      device: office,
      token: session.token,
      body: { currentPassword: lina.password, newPassword },
    });
    expect(changed.statusCode).toBe(200);
    const next = (await signIn(office, lina, newPassword)).json<SignInResponse>();
    remember(next.token);
    expect(next.session.stage).toBe('second_factor');
    expect(await trusts(lina.id)).toEqual([
      { device_id: office.id, end_reason: 'password_changed' },
    ]);
  });

  it('shows the owner who trusts each PC, and the owner can end it', async () => {
    const owner = await twoStepPerson('mohammed', { owner: true });
    const ownerPc = await pc('OWNER-PC');
    const ownerSession = await fullSignIn(ownerPc, owner);

    // The owner, and only the owner, may have a POS PC remember the code (decision 0078).
    const counter = await pc('OWNER-POS', 'pos');
    const onPos = (await signIn(counter, owner)).json<SignInResponse>();
    remember(onPos.token);
    expect(onPos.trustDays).toBe(3650);
    const ticked = await call(server, 'POST', '/api/v1/auth/second-factor', {
      device: counter,
      token: onPos.token,
      body: { code: await freshCode(owner), trustDevice: true },
    });
    expect(ticked.statusCode).toBe(200);
    remember(ticked.json<SignInResponse>().token);
    const backOnPos = (await signIn(counter, owner)).json<SignInResponse>();
    remember(backOnPos.token);
    expect(backOnPos.session).toMatchObject({ stage: 'full', authMethod: 'trusted_device' });
    const nour = await twoStepPerson('nour.trust');
    const nourPc = await pc('NOUR-PC');
    const nourSession = await fullSignIn(nourPc, nour, true);

    const listed = (
      await call(server, 'GET', '/api/v1/devices', { device: ownerPc, token: ownerSession.token })
    ).json<DevicesResponse>();
    const row = listed.devices.find((d) => d.code === 'NOUR-PC')!;
    expect(row.trustedFor).toEqual([
      {
        userId: nour.id.toString(),
        displayNameAr: 'مستخدم',
        displayNameEn: 'User',
        expiresAt: expect.any(String) as string,
      },
    ]);
    expect(listed.devices.find((d) => d.code === 'OWNER-PC')!.trustedFor).toEqual([]);

    // Only people who manage devices may end it.
    const notAllowed = await call(server, 'POST', `/api/v1/devices/${nourPc.id}/end-trust`, {
      device: nourPc,
      token: nourSession.token,
      idempotencyKey: randomUUID(),
    });
    expect(errorCode(notAllowed)).toBe('PERMISSION_DENIED');

    const ended = await call(server, 'POST', `/api/v1/devices/${nourPc.id}/end-trust`, {
      device: ownerPc,
      token: ownerSession.token,
      idempotencyKey: randomUUID(),
    });
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toEqual({ ended: 1 });
    expect(await trusts(nour.id)).toEqual([
      { device_id: nourPc.id, end_reason: 'ended_in_settings' },
    ]);
    const next = (await signIn(nourPc, nour)).json<SignInResponse>();
    remember(next.token);
    expect(next.session.stage).toBe('second_factor');
    const again = (
      await call(server, 'GET', '/api/v1/devices', { device: ownerPc, token: ownerSession.token })
    ).json<DevicesResponse>();
    expect(again.devices.find((d) => d.code === 'NOUR-PC')!.trustedFor).toEqual([]);
  });

  it('follows the setting: 0 turns it off at once and hides the choice', async () => {
    const rami = await twoStepPerson('rami.trust');
    const office = await pc('RAMI-PC');
    await fullSignIn(office, rami, true);
    const trusted = (await signIn(office, rami)).json<SignInResponse>();
    remember(trusted.token);
    expect(trusted.session.authMethod).toBe('trusted_device');
    await setTrustDays(0);
    try {
      const off = (await signIn(office, rami)).json<SignInResponse>();
      remember(off.token);
      expect(off.session.stage).toBe('second_factor');
      expect(off.trustDays).toBeUndefined();
    } finally {
      await setTrustDays(3650);
    }
  });
});

describe('forgot password (decision 0028)', () => {
  const recover = (device: TestDevice, body: Record<string, string>) =>
    call(server, 'POST', '/api/v1/auth/recover-password', { device, body });

  const unusedCodes = async (userId: bigint) =>
    (
      await server.db
        .selectFrom('auth.recovery_codes')
        .select('id')
        .where('user_id', '=', userId)
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .execute()
    ).length;

  it('recovers with the phone code and one recovery code, ends everything else, and signs in here', async () => {
    const huda = await twoStepPerson('huda.recover', {
      recoveryCodes: ['ABCDE-FGHJK', 'MNPQR-STUVW', 'XYZ23-45678'],
    });
    const office = await pc('HUDA-PC');
    const laptop = await pc('HUDA-LAPTOP');
    const elsewhere = await fullSignIn(laptop, huda, true);
    const newPassword = remember('huda-has-a-new-pool-pass');

    const response = await recover(office, {
      username: 'HUDA.recover',
      code: await freshCode(huda),
      recoveryCode: 'abcde fghjk',
      newPassword,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<RecoverPasswordResponse>();
    remember(body.token);
    expect(body.recoveryCodesLeft).toBe(2);
    expect(body.session).toMatchObject({
      stage: 'full',
      authMethod: 'password_totp',
      pending: null,
    });
    const me = await call(server, 'GET', '/api/v1/auth/me', { device: office, token: body.token });
    expect(me.statusCode).toBe(200);

    // Every other session and trusted PC ended; the old password no longer works.
    expect(
      errorCode(
        await call(server, 'GET', '/api/v1/auth/me', { device: laptop, token: elsewhere.token }),
      ),
    ).toBe('SESSION_EXPIRED');
    expect(await trusts(huda.id)).toEqual([
      { device_id: laptop.id, end_reason: 'password_changed' },
    ]);
    expect(errorCode(await signIn(office, huda))).toBe('INVALID_CREDENTIALS');
    const withNew = (await signIn(laptop, huda, newPassword)).json<SignInResponse>();
    remember(withNew.token);
    expect(withNew.session.stage).toBe('second_factor');

    expect(await unusedCodes(huda.id)).toBe(2);
    const [recovered] = await events('auth.password_recovered', huda.id);
    expect(recovered).toMatchObject({ user_id: huda.id, device_id: office.id });
    expect(recovered!.new_values).toMatchObject({ recoveryCodesLeft: 2 });
    expect(await events('auth.recovery_code_used', huda.id)).toHaveLength(1);
  });

  it('gives the same answer whichever part is wrong, uses up nothing, and counts the attempt', async () => {
    const adel = await twoStepPerson('adel.recover', { recoveryCodes: ['ABCDE-FGHJK'] });
    await addUser(server, { username: 'plain.recover', password: remember('plain-user-password') });
    const office = await pc('ADEL-PC');
    const newPassword = remember('adel-wants-a-new-one');
    const answers = [
      await recover(office, {
        username: 'adel.recover',
        code: '000000',
        recoveryCode: 'ABCDE-FGHJK',
        newPassword,
      }),
      await recover(office, {
        username: 'adel.recover',
        code: await freshCode(adel),
        recoveryCode: 'ZZZZZ-ZZZZZ',
        newPassword,
      }),
      await recover(office, {
        username: 'nobody.here',
        code: '123456',
        recoveryCode: 'ABCDE-FGHJK',
        newPassword,
      }),
      await recover(office, {
        username: 'plain.recover',
        code: '123456',
        recoveryCode: 'ABCDE-FGHJK',
        newPassword,
      }),
    ];
    for (const answer of answers) {
      expect(answer.statusCode).toBe(401);
      expect(answer.json()).toEqual(answers[0]!.json());
    }
    expect(errorCode(answers[0]!)).toBe('RECOVERY_REFUSED');
    expect(await unusedCodes(adel.id)).toBe(1);
    const { failed_login_count } = await server.db
      .selectFrom('auth.users')
      .select('failed_login_count')
      .where('id', '=', adel.id)
      .executeTakeFirstOrThrow();
    expect(failed_login_count).toBe(2);
    expect(
      (await events('auth.password_recovery_failed', adel.id)).map((e) => e.new_values),
    ).toEqual([{ reason: 'wrong_code' }, { reason: 'wrong_recovery_code' }]);
    // The original password still works.
    const stillOld = (await signIn(office, adel)).json<SignInResponse>();
    remember(stillOld.token);
    expect(stillOld.session.stage).toBe('second_factor');
  });

  it('refuses a weak new password before using any code', async () => {
    const weak = await twoStepPerson('weak.recover', { recoveryCodes: ['ABCDE-FGHJK'] });
    const office = await pc('WEAK-PC');
    const response = await recover(office, {
      username: 'weak.recover',
      code: await freshCode(weak),
      recoveryCode: 'ABCDE-FGHJK',
      newPassword: 'short',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'PASSWORD_REJECTED', details: { problems: ['too_short'], minLength: 10 } },
    });
    expect(await unusedCodes(weak.id)).toBe(1);
  });

  it('works while the account is locked, and unlocks it', async () => {
    const locked = await twoStepPerson('locked.recover', { recoveryCodes: ['ABCDE-FGHJK'] });
    const office = await pc('LOCKED-PC');
    for (let i = 0; i < 5; i++) await signIn(office, locked, remember(`wrong-password-${i}x`));
    expect(errorCode(await signIn(office, locked))).toBe('ACCOUNT_LOCKED');
    const newPassword = remember('locked-out-no-more');
    const response = await recover(office, {
      username: 'locked.recover',
      code: await freshCode(locked),
      recoveryCode: 'ABCDE-FGHJK',
      newPassword,
    });
    expect(response.statusCode).toBe(200);
    remember(response.json<RecoverPasswordResponse>().token);
    const next = (await signIn(office, locked, newPassword)).json<SignInResponse>();
    remember(next.token);
    expect(next.session.stage).toBe('second_factor');
  });

  it('accepts the same 6-digit code only once', async () => {
    const once = await twoStepPerson('once.recover', {
      recoveryCodes: ['ABCDE-FGHJK', 'MNPQR-STUVW'],
    });
    const office = await pc('ONCE-PC');
    const code = await freshCode(once);
    const first = await recover(office, {
      username: 'once.recover',
      code,
      recoveryCode: 'ABCDE-FGHJK',
      newPassword: remember('once-first-new-pass'),
    });
    expect(first.statusCode).toBe(200);
    remember(first.json<RecoverPasswordResponse>().token);
    const replay = await recover(office, {
      username: 'once.recover',
      code,
      recoveryCode: 'MNPQR-STUVW',
      newPassword: remember('once-second-new-pass'),
    });
    expect(errorCode(replay)).toBe('RECOVERY_REFUSED');
    expect(await unusedCodes(once.id)).toBe(1);
  });
});

describe('secrets', () => {
  it('never appear in the server logs or the audit log', async () => {
    const audit = await server.db
      .selectFrom('audit.log')
      .select(['old_values', 'new_values'])
      .execute();
    const documents = [...server.logs.map((line) => JSON.parse(line) as unknown), ...audit];
    const everything = documents.flatMap((d) => textValues(d)).join('\n');
    expect(secrets.length).toBeGreaterThan(30);
    for (const secret of secrets) {
      if (secret.length >= 8) expect(everything).not.toContain(secret);
    }
    // Recovery codes are also checked without their dash, as they may be typed.
    for (const code of ['ABCDEFGHJK', 'MNPQRSTUVW', 'XYZ2345678']) {
      expect(everything).not.toContain(code);
    }
  });
});

/** Every text value inside a JSON document (log line or audit entry), at any depth. */
function textValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => textValues(v, out));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((v) => textValues(v, out));
  return out;
}
