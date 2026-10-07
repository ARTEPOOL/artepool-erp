/**
 * T4: sign-in (decisions 0021–0023). Lockout, the 2-step code and its replay protection, recovery
 * codes, PIN sign-in only on POS PCs, own password/PIN changes, lock and unlock, sign out — and
 * no secret ever reaching the logs or the audit log.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  MeResponse,
  PinUsersResponse,
  SignInResponse,
  TwoStepConfirmResponse,
  TwoStepStartResponse,
} from '@artepool/shared/contracts';
import { newTotpSecret, totpCode } from '../../src/platform/auth/totp';
import { normalizeCode } from '../../src/platform/crypto/codes';
import { withBusinessTx } from '../../src/platform/db/tx';
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
let office: TestDevice;
let pos: TestDevice;
/** Every secret used in this file; none may appear in any log or audit entry. */
const secrets: string[] = [];
const remember = <T extends string>(secret: T): T => {
  secrets.push(secret);
  return secret;
};

beforeAll(async () => {
  server = await startTestServer();
  office = await addDevice(server, { code: 'OFFICE-01', kind: 'office' });
  pos = await addDevice(server, { code: 'COUNTER-01', kind: 'pos' });
  secrets.push(office.key, pos.key);
});
afterAll(() => server.close());

const signIn = (device: TestDevice, username: string, password: string) =>
  call(server, 'POST', '/api/v1/auth/sign-in', { device, body: { username, password } });

const asOwnerOf = (userId: bigint) => ({ userId, requestId: randomUUID(), reason: 'test fixture' });

/** Turns on the 2-step code for a user (as the setup screen would) and adds recovery codes. */
async function enableTwoStep(userId: bigint, recovery: string[] = []): Promise<string> {
  const secret = remember(newTotpSecret());
  const hashes = await Promise.all(recovery.map((c) => server.deps.hasher.hash(normalizeCode(c))));
  await withBusinessTx(server.db, asOwnerOf(userId), async (trx) => {
    await trx
      .updateTable('auth.users')
      .set({
        totp_secret_enc: server.deps.secretBox.seal(
          Buffer.from(secret),
          `auth.users.totp_secret_enc:${userId}`,
        ),
        totp_enabled: true,
      })
      .where('id', '=', userId)
      .execute();
    for (const code_hash of hashes) {
      await trx
        .insertInto('auth.recovery_codes')
        .values({ user_id: userId, code_hash } as never)
        .execute();
    }
  });
  return secret;
}

async function events(action: string, entityId?: bigint) {
  let query = server.db
    .selectFrom('audit.log')
    .select(['user_id', 'device_id', 'entity_id', 'new_values'])
    .where('action', '=', `event:${action}`);
  if (entityId !== undefined) query = query.where('entity_id', '=', entityId.toString());
  return query.orderBy('id').execute();
}

describe('password sign-in (decision 0023)', () => {
  let userId: bigint;
  const password = remember('pool-water-is-blue-26');

  beforeAll(async () => {
    userId = await addUser(server, { username: 'khaled.acc', roles: ['accountant'], password });
  });

  it('signs in with the right password and records it', async () => {
    const response = await signIn(office, 'Khaled.Acc', password);
    expect(response.statusCode).toBe(200);
    const body = response.json<SignInResponse>();
    remember(body.token);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.session).toMatchObject({
      stage: 'full',
      authMethod: 'password',
      pending: null,
      locked: false,
      idleTimeoutSeconds: 900,
    });
    expect(body.user).toMatchObject({ id: userId.toString(), username: 'khaled.acc' });
    const [event] = await events('auth.signed_in', userId);
    expect(event).toMatchObject({ user_id: userId, device_id: office.id });
  });

  it('gives the same answer for a wrong password and an unknown user, and stores no typed username', async () => {
    const wrong = await signIn(office, 'khaled.acc', remember('not-the-password-1'));
    const unknown = await signIn(office, 'nobody.here', remember('not-the-password-2'));
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(errorCode(unknown)).toBe('INVALID_CREDENTIALS');
    const failures = await events('auth.sign_in_failed');
    expect(failures.map((e) => e.new_values)).toEqual([
      { reason: 'wrong_password', step: 'sign_in', attempts: 1 },
      { reason: 'unknown_user' },
    ]);
    expect(JSON.stringify(failures.map((f) => f.new_values))).not.toContain('nobody.here');
  });

  it('refuses deactivated users and PIN users the same way', async () => {
    const pinUser = await addUser(server, {
      username: 'pin.only',
      method: 'pin',
      roles: ['cashier'],
    });
    expect(errorCode(await signIn(office, 'pin.only', remember('pin-users-have-none')))).toBe(
      'INVALID_CREDENTIALS',
    );
    expect(pinUser).toBeGreaterThan(0n);
    const leaver = await addUser(server, { username: 'leaver', password });
    await withBusinessTx(server.db, asOwnerOf(1n), (trx) =>
      trx
        .updateTable('auth.users')
        .set({ is_active: false, deactivation_reason: 'left the company' })
        .where('id', '=', leaver)
        .execute(),
    );
    expect(errorCode(await signIn(office, 'leaver', password))).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account for 15 minutes after 5 wrong passwords, even for the right one', async () => {
    const victim = await addUser(server, {
      username: 'yousef.store',
      roles: ['storekeeper'],
      password,
    });
    for (let i = 1; i <= 4; i++) {
      expect(errorCode(await signIn(office, 'yousef.store', `wrong-password-${i}`))).toBe(
        'INVALID_CREDENTIALS',
      );
    }
    const fifth = await signIn(office, 'yousef.store', 'wrong-password-5');
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json()).toEqual({ error: { code: 'ACCOUNT_LOCKED', details: { minutes: 15 } } });
    const right = await signIn(office, 'yousef.store', password);
    expect(errorCode(right)).toBe('ACCOUNT_LOCKED');
    expect(await events('auth.account_locked', victim)).toHaveLength(1);

    await ageRow(
      server,
      `UPDATE auth.users SET locked_until = now() - interval '1 second' WHERE id = $1`,
      [victim.toString()],
    );
    expect((await signIn(office, 'yousef.store', password)).statusCode).toBe(200);
    const row = await server.db
      .selectFrom('auth.users')
      .select(['locked_until', 'failed_login_count'])
      .where('id', '=', victim)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ locked_until: null, failed_login_count: 0 });
  });

  it('allows one person at a time on a PC: a new sign-in ends the previous one', async () => {
    const first = (await signIn(office, 'khaled.acc', password)).json<SignInResponse>();
    const other = await addUser(server, { username: 'sara.acc', roles: ['accountant'], password });
    const second = await signIn(office, 'sara.acc', password);
    expect(second.statusCode).toBe(200);
    expect(
      errorCode(
        await call(server, 'GET', '/api/v1/auth/me', { device: office, token: first.token }),
      ),
    ).toBe('SESSION_EXPIRED');
    expect(other).toBeGreaterThan(0n);
  });

  it('slows down a PC that tries too many times', async () => {
    const busy = await addDevice(server, { code: 'BUSY-PC' });
    secrets.push(busy.key);
    for (let i = 0; i < 20; i++) await signIn(busy, 'nobody', 'x');
    const response = await signIn(busy, 'khaled.acc', password);
    expect(response.statusCode).toBe(429);
    expect(errorCode(response)).toBe('RATE_LIMITED');
  });
});

describe('the owner 2-step code (decision 0022)', () => {
  let ownerId: bigint;
  let secret: string;
  let ownerPc: TestDevice;
  const password = remember('owner-strong-passphrase');
  const recovery = [remember('ABCDE-FGHJK'), remember('MNPQR-STUVW')];

  beforeAll(async () => {
    ownerId = await addUser(server, {
      username: 'mohammed',
      method: 'password_totp',
      roles: ['owner'],
      password,
    });
    secret = await enableTwoStep(ownerId, recovery);
    ownerPc = await addDevice(server, { code: 'OWNER-PC' });
    secrets.push(ownerPc.key);
  });

  it('asks for the code after the password; nothing else works until then', async () => {
    const first = await signIn(ownerPc, 'mohammed', password);
    const body = first.json<SignInResponse>();
    remember(body.token);
    expect(body.session).toMatchObject({ stage: 'second_factor', pending: null });
    expect(
      errorCode(
        await call(server, 'GET', '/api/v1/auth/me', { device: ownerPc, token: body.token }),
      ),
    ).toBe('SECOND_FACTOR_REQUIRED');
    const wrong = await call(server, 'POST', '/api/v1/auth/second-factor', {
      device: ownerPc,
      token: body.token,
      body: { code: '000000' },
    });
    expect(errorCode(wrong)).toBe('INVALID_TWO_STEP_CODE');

    const code = remember(totpCode(secret));
    const right = await call(server, 'POST', '/api/v1/auth/second-factor', {
      device: ownerPc,
      token: body.token,
      body: { code },
    });
    expect(right.statusCode).toBe(200);
    const full = right.json<SignInResponse>();
    remember(full.token);
    expect(full.token).not.toBe(body.token);
    expect(full.session).toMatchObject({
      stage: 'full',
      authMethod: 'password_totp',
      pending: null,
    });
    // The waiting session is gone; only the new token works.
    expect(
      errorCode(
        await call(server, 'GET', '/api/v1/auth/me', { device: ownerPc, token: body.token }),
      ),
    ).toBe('SESSION_EXPIRED');
    const me = (
      await call(server, 'GET', '/api/v1/auth/me', { device: ownerPc, token: full.token })
    ).json<MeResponse>();
    expect(me.permissions).toContain('users.manage');
    expect(me.device).toEqual({
      id: ownerPc.id.toString(),
      code: 'OWNER-PC',
      name: 'Test PC',
      kind: 'office',
    });

    // The same code can never be used again (replay).
    const again = (await signIn(ownerPc, 'mohammed', password)).json<SignInResponse>();
    remember(again.token);
    const replay = await call(server, 'POST', '/api/v1/auth/second-factor', {
      device: ownerPc,
      token: again.token,
      body: { code },
    });
    expect(errorCode(replay)).toBe('INVALID_TWO_STEP_CODE');
  });

  it('accepts the same code only once even when it arrives twice at the same moment', async () => {
    const a = (await signIn(ownerPc, 'mohammed', password)).json<SignInResponse>();
    const twin = await addDevice(server, { code: 'TWIN-PC' });
    secrets.push(twin.key);
    const b = (await signIn(twin, 'mohammed', password)).json<SignInResponse>();
    remember(a.token);
    remember(b.token);
    const code = remember(totpCode(secret, Date.now() + 30_000));
    const [first, second] = await Promise.all([
      call(server, 'POST', '/api/v1/auth/second-factor', {
        device: ownerPc,
        token: a.token,
        body: { code },
      }),
      call(server, 'POST', '/api/v1/auth/second-factor', {
        device: twin,
        token: b.token,
        body: { code },
      }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 401]);
    for (const r of [first, second])
      if (r.statusCode === 200) remember(r.json<SignInResponse>().token);
  });

  it('accepts a recovery code once, then requires setting up the 2-step code again', async () => {
    const waiting = (await signIn(ownerPc, 'mohammed', password)).json<SignInResponse>();
    remember(waiting.token);
    const used = await call(server, 'POST', '/api/v1/auth/second-factor', {
      device: ownerPc,
      token: waiting.token,
      body: { recoveryCode: recovery[0]!.toLowerCase().replace('-', ' ') },
    });
    expect(used.statusCode).toBe(200);
    const session = used.json<SignInResponse>();
    remember(session.token);
    expect(session.session).toMatchObject({
      authMethod: 'recovery_code',
      pending: 'two_step_setup',
    });

    const reuse = (await signIn(ownerPc, 'mohammed', password)).json<SignInResponse>();
    remember(reuse.token);
    const refused = await call(server, 'POST', '/api/v1/auth/second-factor', {
      device: ownerPc,
      token: reuse.token,
      body: { recoveryCode: recovery[0]! },
    });
    expect(errorCode(refused)).toBe('INVALID_TWO_STEP_CODE');
    expect(await events('auth.recovery_code_used', ownerId)).toHaveLength(1);
  });

  it('sets up a new phone: QR secret, a matching code, then 10 new recovery codes shown once', async () => {
    const waiting = (await signIn(ownerPc, 'mohammed', password)).json<SignInResponse>();
    const viaRecovery = (
      await call(server, 'POST', '/api/v1/auth/second-factor', {
        device: ownerPc,
        token: waiting.token,
        body: { recoveryCode: recovery[1]! },
      })
    ).json<SignInResponse>();
    remember(waiting.token);
    remember(viaRecovery.token);
    const start = await call(server, 'POST', '/api/v1/auth/two-step/start', {
      device: ownerPc,
      token: viaRecovery.token,
    });
    const setup = start.json<TwoStepStartResponse>();
    remember(setup.secret);
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\/ARTEPOOL:mohammed\?/);
    const wrong = await call(server, 'POST', '/api/v1/auth/two-step/confirm', {
      device: ownerPc,
      token: viaRecovery.token,
      body: { code: '123456' },
    });
    expect(errorCode(wrong)).toBe('INVALID_TWO_STEP_CODE');
    const confirmed = await call(server, 'POST', '/api/v1/auth/two-step/confirm', {
      device: ownerPc,
      token: viaRecovery.token,
      body: { code: remember(totpCode(setup.secret)) },
    });
    expect(confirmed.statusCode).toBe(200);
    const result = confirmed.json<TwoStepConfirmResponse>();
    result.recoveryCodes.forEach(remember);
    remember(result.token);
    expect(result.recoveryCodes).toHaveLength(10);
    expect(new Set(result.recoveryCodes).size).toBe(10);
    expect(result.session).toMatchObject({ authMethod: 'password_totp', pending: null });

    const codes = await server.db
      .selectFrom('auth.recovery_codes')
      .select(['code_hash', 'used_at', 'revoked_at'])
      .where('user_id', '=', ownerId)
      .execute();
    expect(codes.filter((c) => !c.used_at && !c.revoked_at)).toHaveLength(10);
    expect(codes.every((c) => c.code_hash.startsWith('$argon2id$'))).toBe(true);
    // The old phone's secret no longer works; the new one does.
    secret = setup.secret;
    const me = await call(server, 'GET', '/api/v1/auth/me', {
      device: ownerPc,
      token: result.token,
    });
    expect(me.json<MeResponse>().session.pending).toBeNull();
  });

  it('locks the account after 5 wrong codes and ends the waiting session', async () => {
    const lockPc = await addDevice(server, { code: 'LOCK-PC' });
    secrets.push(lockPc.key);
    const waiting = (await signIn(lockPc, 'mohammed', password)).json<SignInResponse>();
    remember(waiting.token);
    const answers: string[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await call(server, 'POST', '/api/v1/auth/second-factor', {
        device: lockPc,
        token: waiting.token,
        body: { code: String(100000 + i) },
      });
      answers.push(errorCode(response) ?? '');
    }
    expect(answers).toEqual([...Array<string>(4).fill('INVALID_TWO_STEP_CODE'), 'ACCOUNT_LOCKED']);
    expect(errorCode(await signIn(lockPc, 'mohammed', password))).toBe('ACCOUNT_LOCKED');
    await ageRow(server, `UPDATE auth.users SET locked_until = NULL WHERE id = $1`, [
      ownerId.toString(),
    ]);
  });

  it('first-time setup: a new owner signs in with the password and must set up 2-step first', async () => {
    const fresh = await server.testDb.connect('superuser');
    await fresh.query('BEGIN');
    await fresh.query(`SELECT sys.set_context(1, p_reason => 'test')`);
    await fresh.query(
      `UPDATE auth.users SET totp_enabled = false, totp_secret_enc = NULL WHERE id = $1`,
      [ownerId.toString()],
    );
    await fresh.query('COMMIT');
    const session = (await signIn(ownerPc, 'mohammed', password)).json<SignInResponse>();
    remember(session.token);
    expect(session.session).toMatchObject({ stage: 'full', pending: 'two_step_setup' });
    const users = await call(server, 'GET', '/api/v1/auth/me', {
      device: ownerPc,
      token: session.token,
    });
    expect(users.statusCode).toBe(200);
  });
});

describe('PIN sign-in only on POS PCs (decision 0021)', () => {
  let cashierId: bigint;
  const pin = remember('4829');

  beforeAll(async () => {
    cashierId = await addUser(server, {
      username: 'ahmed.cashier',
      method: 'pin',
      roles: ['cashier'],
      pin,
      mustChange: true,
    });
  });

  const pinSignIn = (device: TestDevice, value: string, userId = cashierId) =>
    call(server, 'POST', '/api/v1/auth/pin-sign-in', {
      device,
      body: { userId: userId.toString(), pin: value },
    });

  it('lists PIN users only on POS PCs, and refuses PIN sign-in elsewhere', async () => {
    const onOffice = (
      await call(server, 'GET', '/api/v1/auth/pin-users', { device: office })
    ).json<PinUsersResponse>();
    expect(onOffice).toEqual({ pinAllowed: false, users: [] });
    const onPos = (
      await call(server, 'GET', '/api/v1/auth/pin-users', { device: pos })
    ).json<PinUsersResponse>();
    expect(onPos.pinAllowed).toBe(true);
    expect(onPos.users).toContainEqual({
      id: cashierId.toString(),
      displayNameAr: 'مستخدم',
      displayNameEn: 'User',
      blocked: false,
    });
    expect(errorCode(await pinSignIn(office, pin))).toBe('SIGN_IN_NOT_ALLOWED');
  });

  it('signs in with the PIN (Arabic digits too), then asks for a new PIN first', async () => {
    const response = await pinSignIn(pos, '٤٨٢٩');
    expect(response.statusCode).toBe(200);
    const body = response.json<SignInResponse>();
    remember(body.token);
    expect(body.session).toMatchObject({
      authMethod: 'pin',
      pending: 'credential_change',
      idleTimeoutSeconds: 300,
    });
    const weak = await call(server, 'POST', '/api/v1/auth/change-pin', {
      device: pos,
      token: body.token,
      body: { current: pin, newPin: '1234' },
    });
    expect(weak.json()).toEqual({
      error: { code: 'PIN_REJECTED', details: { problems: ['weak'] } },
    });
    const same = await call(server, 'POST', '/api/v1/auth/change-pin', {
      device: pos,
      token: body.token,
      body: { current: pin, newPin: pin },
    });
    expect(same.json()).toEqual({
      error: { code: 'PIN_REJECTED', details: { problems: ['same_as_current'] } },
    });
    const changed = await call(server, 'POST', '/api/v1/auth/change-pin', {
      device: pos,
      token: body.token,
      body: { current: pin, newPin: remember('5291') },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ pending: null });
  });

  it('blocks the PIN after 5 wrong tries until the owner unblocks it', async () => {
    for (let i = 0; i < 4; i++)
      expect(errorCode(await pinSignIn(pos, `70${i}3`))).toBe('INVALID_PIN');
    expect(errorCode(await pinSignIn(pos, '7083'))).toBe('PIN_BLOCKED');
    expect(errorCode(await pinSignIn(pos, '5291'))).toBe('PIN_BLOCKED');
    const list = (
      await call(server, 'GET', '/api/v1/auth/pin-users', { device: pos })
    ).json<PinUsersResponse>();
    expect(list.users.find((u) => u.id === cashierId.toString())?.blocked).toBe(true);
    expect(await events('auth.pin_blocked', cashierId)).toHaveLength(1);
  });
});

describe('own password, lock, unlock and sign out', () => {
  let userId: bigint;
  let monaPc: TestDevice;
  const temporary = remember('temporary-pass-9');
  const chosen = remember('my-own-garden-path');

  beforeAll(async () => {
    userId = await addUser(server, {
      username: 'mona.acc',
      roles: ['accountant'],
      password: temporary,
      mustChange: true,
    });
    monaPc = await addDevice(server, { code: 'MONA-PC' });
    secrets.push(monaPc.key);
  });

  it('makes a user with a temporary password choose their own first', async () => {
    const session = (await signIn(monaPc, 'mona.acc', temporary)).json<SignInResponse>();
    remember(session.token);
    expect(session.session.pending).toBe('credential_change');
    const change = (body: object) =>
      call(server, 'POST', '/api/v1/auth/change-password', {
        device: monaPc,
        token: session.token,
        body,
      });
    const weak = await change({ currentPassword: temporary, newPassword: 'mona.acc-2026' });
    expect(weak.json()).toEqual({
      error: {
        code: 'PASSWORD_REJECTED',
        details: { problems: ['contains_username'], minLength: 10 },
      },
    });
    expect(
      errorCode(await change({ currentPassword: 'wrong-current-1', newPassword: chosen })),
    ).toBe('INVALID_CREDENTIALS');
    const other = await openSession(server, { userId, deviceId: pos.id });
    const ok = await change({ currentPassword: temporary, newPassword: chosen });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ pending: null });
    // The user's other sessions end; this one continues.
    const ended = await server.db
      .selectFrom('auth.sessions')
      .select('end_reason')
      .where('id', '=', other.id)
      .executeTakeFirstOrThrow();
    expect(ended.end_reason).toBe('credential_changed');
    expect(
      (await call(server, 'GET', '/api/v1/auth/me', { device: monaPc, token: session.token }))
        .statusCode,
    ).toBe(200);
    expect(errorCode(await signIn(monaPc, 'mona.acc', temporary))).toBe('INVALID_CREDENTIALS');
  });

  it('locks the screen and unlocks it with the same password', async () => {
    const session = (await signIn(monaPc, 'mona.acc', chosen)).json<SignInResponse>();
    remember(session.token);
    const opts = { device: monaPc, token: session.token };
    expect((await call(server, 'POST', '/api/v1/auth/lock', opts)).json()).toMatchObject({
      locked: true,
    });
    expect(errorCode(await call(server, 'GET', '/api/v1/auth/me', opts))).toBe('SESSION_LOCKED');
    expect(
      errorCode(
        await call(server, 'POST', '/api/v1/auth/unlock', {
          ...opts,
          body: { secret: 'nope-nope-nope' },
        }),
      ),
    ).toBe('INVALID_CREDENTIALS');
    const unlocked = await call(server, 'POST', '/api/v1/auth/unlock', {
      ...opts,
      body: { secret: chosen },
    });
    expect(unlocked.json()).toMatchObject({ locked: false });
    expect((await call(server, 'GET', '/api/v1/auth/me', opts)).statusCode).toBe(200);
    expect((await events('auth.session_locked')).length).toBeGreaterThan(0);
    expect((await events('auth.session_unlocked')).length).toBe(1);
  });

  it('signs out: the token stops working at once', async () => {
    const session = (await signIn(monaPc, 'mona.acc', chosen)).json<SignInResponse>();
    remember(session.token);
    const opts = { device: monaPc, token: session.token };
    expect((await call(server, 'POST', '/api/v1/auth/sign-out', opts)).statusCode).toBe(204);
    expect(errorCode(await call(server, 'GET', '/api/v1/auth/me', opts))).toBe('SESSION_EXPIRED');
  });
});

describe('secrets', () => {
  it('never appear in the server logs or the audit log', async () => {
    const logs = server.logs.join('\n');
    const audit = (
      await sql<{
        t: string;
      }>`SELECT string_agg(coalesce(old_values::text, '') || coalesce(new_values::text, ''), ' ') AS t
                                FROM audit.log`.execute(server.db)
    ).rows[0]!.t;
    expect(secrets.length).toBeGreaterThan(25);
    for (const secret of secrets) {
      expect(logs, 'server log').not.toContain(secret);
      expect(audit, 'audit log').not.toContain(secret);
    }
  });
});
