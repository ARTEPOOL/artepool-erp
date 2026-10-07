/**
 * Sign-in, 2-step code, PIN, own password/PIN changes, lock and unlock (decisions 0021–0023).
 * Every attempt, good or bad, is written to the audit log; secrets never are.
 */
import type { FastifyRequest } from 'fastify';
import { sql, type Transaction } from 'kysely';
import type {
  ChangePasswordRequest,
  ChangePinRequest,
  MeResponse,
  PinSignInRequest,
  PinUsersResponse,
  SecondFactorRequest,
  SessionView,
  SignInRequest,
  SignInResponse,
  TwoStepConfirmResponse,
  TwoStepStartResponse,
} from '@artepool/shared/contracts';
import { recordEvent } from '../../platform/audit/events';
import { checkPassword } from '../../platform/auth/password-policy';
import { checkPin, normalizePin } from '../../platform/auth/pin-policy';
import { newTotpSecret, totpUri, verifyTotp } from '../../platform/auth/totp';
import { newRecoveryCode, normalizeCode } from '../../platform/crypto/codes';
import type { DB } from '../../platform/db/schema.generated';
import { withBusinessTx } from '../../platform/db/tx';
import { AppError } from '../../platform/errors/app-error';
import { contextOf } from '../../platform/http/context';
import type { AppDeps } from '../../platform/http/deps';
import { permissionsOf } from '../../platform/permissions';
import {
  deviceView,
  endSessions,
  openSession,
  pendingFor,
  USER_COLUMNS,
  userView,
} from './sessions';

const RECOVERY_CODE_COUNT = 10;
const TWO_STEP_SETUP_MS = 10 * 60_000;

/** The 2-step secret is bound to its user row, so it cannot be copied to another user. */
const totpAad = (userId: bigint): string => `auth.users.totp_secret_enc:${userId}`;

/** Secrets of a 2-step setup in progress, by session (memory only, at most 10 minutes). */
const pendingTwoStep = new Map<bigint, { secret: string; expires: number }>();

function rateCheck(deps: AppDeps, request: FastifyRequest): void {
  const key = `device:${request.device!.id}`;
  const wait = deps.limits.signIn.retryAfter(key);
  if (wait > 0) throw new AppError('RATE_LIMITED', 'Too many sign-in attempts', { seconds: wait });
  deps.limits.signIn.hit(key);
}

const userEntity = (id: bigint) => ({ entityType: 'auth.users', entityId: id });

/**
 * A wrong password (sign-in, unlock or password change): counts towards the lockout. Returns the
 * lockout minutes when this failure locked the account. Recorded by SYSTEM: nobody is proven yet.
 */
async function passwordFailed(
  trx: Transaction<DB>,
  deps: AppDeps,
  userId: bigint,
  step: string,
): Promise<number | null> {
  const { failed_login_count: attempts } = await trx
    .updateTable('auth.users')
    .set({ failed_login_count: sql`failed_login_count + 1` })
    .where('id', '=', userId)
    .returning('failed_login_count')
    .executeTakeFirstOrThrow();
  await recordEvent(trx, 'auth.sign_in_failed', {
    ...userEntity(userId),
    data: { reason: 'wrong_password', step, attempts },
  });
  if (attempts < (await deps.settings.number('security.max_failed_logins'))) return null;
  const minutes = await deps.settings.number('security.lockout_minutes');
  await trx
    .updateTable('auth.users')
    .set({ locked_until: sql`now() + make_interval(mins => ${minutes})`, failed_login_count: 0 })
    .where('id', '=', userId)
    .execute();
  await recordEvent(trx, 'auth.account_locked', { ...userEntity(userId), data: { minutes } });
  return minutes;
}

/** A wrong PIN (sign-in, unlock, approval): counts towards the PIN block (decision 0021). */
async function pinFailed(
  trx: Transaction<DB>,
  deps: AppDeps,
  userId: bigint,
  step: string,
): Promise<boolean> {
  const { pin_failed_count: attempts } = await trx
    .updateTable('auth.users')
    .set({ pin_failed_count: sql`pin_failed_count + 1` })
    .where('id', '=', userId)
    .returning('pin_failed_count')
    .executeTakeFirstOrThrow();
  await recordEvent(trx, 'auth.pin_failed', { ...userEntity(userId), data: { step, attempts } });
  if (attempts < (await deps.settings.number('security.max_failed_pins'))) return false;
  await trx
    .updateTable('auth.users')
    .set({ pin_blocked_at: sql`now()` })
    .where('id', '=', userId)
    .execute();
  await recordEvent(trx, 'auth.pin_blocked', { ...userEntity(userId), data: { attempts } });
  return true;
}

const lockedError = (minutes: number) =>
  new AppError('ACCOUNT_LOCKED', 'Account locked', { minutes: Math.max(1, minutes) });

function selectUser(deps: AppDeps) {
  return deps.db
    .selectFrom('auth.users')
    .select([
      ...USER_COLUMNS,
      'is_active',
      'password_hash',
      'pin_hash',
      'pin_blocked_at',
      'locked_until',
      'totp_secret_enc',
      'totp_last_step',
      sql<number>`greatest(0, ceil(extract(epoch FROM locked_until - now()) / 60))::int`.as(
        'locked_minutes',
      ),
    ]);
}

// ---------------------------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------------------------

export async function signInWithPassword(
  deps: AppDeps,
  request: FastifyRequest,
  body: SignInRequest,
): Promise<SignInResponse> {
  rateCheck(deps, request);
  const user = await selectUser(deps)
    .where(sql`lower(username)`, '=', body.username.trim().toLowerCase())
    .executeTakeFirst();
  const usable =
    user !== undefined && user.id !== 1n && user.is_active && user.sign_in_method !== 'pin';
  const passwordOk = await deps.hasher.verifyOrDummy(
    usable ? user.password_hash : null,
    body.password,
  );

  if (!usable || !passwordOk || user.locked_minutes > 0) {
    const lockedMinutes = await withBusinessTx(deps.db, contextOf(request), async (trx) => {
      if (!usable) {
        // The typed username is not stored: people sometimes type their password there.
        await recordEvent(trx, 'auth.sign_in_failed', {
          ...(user && user.id !== 1n ? userEntity(user.id) : {}),
          data: { reason: user ? (user.is_active ? 'wrong_method' : 'inactive') : 'unknown_user' },
        });
        return null;
      }
      if (user.locked_minutes > 0) {
        await recordEvent(trx, 'auth.sign_in_refused', {
          ...userEntity(user.id),
          data: { reason: 'locked' },
        });
        return user.locked_minutes;
      }
      return passwordFailed(trx, deps, user.id, 'sign_in');
    });
    if (lockedMinutes !== null) throw lockedError(lockedMinutes);
    throw new AppError('INVALID_CREDENTIALS', 'Wrong username or password');
  }

  return withBusinessTx(deps.db, contextOf(request, { userId: user.id }), async (trx) => {
    const rehash = deps.hasher.needsRehash(user.password_hash!)
      ? await deps.hasher.hash(body.password)
      : undefined;
    await trx
      .updateTable('auth.users')
      .set({
        failed_login_count: 0,
        last_login_at: sql`now()`,
        ...(user.locked_until !== null ? { locked_until: null } : {}),
        ...(rehash ? { password_hash: rehash } : {}),
      })
      .where('id', '=', user.id)
      .execute();
    const stage =
      user.sign_in_method === 'password_totp' && user.totp_enabled ? 'second_factor' : 'full';
    if (stage === 'full') await endSessions(trx, { deviceId: request.device!.id }, 'user_switch');
    const opened = await openSession(trx, deps, {
      user,
      device: request.device!,
      stage,
      method: 'password',
      clientIp: request.ip,
    });
    await recordEvent(trx, stage === 'full' ? 'auth.signed_in' : 'auth.password_accepted', {
      ...userEntity(user.id),
      data: { method: 'password', stage, sessionId: opened.id },
    });
    return { token: opened.token, session: opened.session, user: userView(user) };
  });
}

export async function pinUsers(deps: AppDeps, request: FastifyRequest): Promise<PinUsersResponse> {
  if (request.device!.kind !== 'pos') return { pinAllowed: false, users: [] };
  const rows = await deps.db
    .selectFrom('auth.users')
    .select(['id', 'display_name_ar', 'display_name_en', 'pin_blocked_at'])
    .where('sign_in_method', '=', 'pin')
    .where('is_active', '=', true)
    .where('id', '<>', 1n)
    .orderBy('display_name_en')
    .execute();
  return {
    pinAllowed: true,
    users: rows.map((r) => ({
      id: r.id.toString(),
      displayNameAr: r.display_name_ar,
      displayNameEn: r.display_name_en,
      blocked: r.pin_blocked_at !== null,
    })),
  };
}

export async function signInWithPin(
  deps: AppDeps,
  request: FastifyRequest,
  body: PinSignInRequest,
): Promise<SignInResponse> {
  if (request.device!.kind !== 'pos') {
    throw new AppError('SIGN_IN_NOT_ALLOWED', 'PIN sign-in only on POS devices');
  }
  rateCheck(deps, request);
  const user = await selectUser(deps).where('id', '=', BigInt(body.userId)).executeTakeFirst();
  const usable =
    user !== undefined && user.id !== 1n && user.is_active && user.sign_in_method === 'pin';
  const pinOk = await deps.hasher.verifyOrDummy(
    usable && user.pin_blocked_at === null ? user.pin_hash : null,
    normalizePin(body.pin),
  );

  if (!usable || user.pin_blocked_at !== null || !pinOk) {
    const blocked = await withBusinessTx(deps.db, contextOf(request), async (trx) => {
      if (!usable) {
        await recordEvent(trx, 'auth.sign_in_failed', { data: { reason: 'unknown_user' } });
        return false;
      }
      if (user.pin_blocked_at !== null) {
        await recordEvent(trx, 'auth.sign_in_refused', {
          ...userEntity(user.id),
          data: { reason: 'pin_blocked' },
        });
        return true;
      }
      return pinFailed(trx, deps, user.id, 'sign_in');
    });
    if (blocked) throw new AppError('PIN_BLOCKED', 'PIN blocked');
    throw new AppError('INVALID_PIN', 'Wrong PIN');
  }

  return withBusinessTx(deps.db, contextOf(request, { userId: user.id }), async (trx) => {
    await trx
      .updateTable('auth.users')
      .set({ pin_failed_count: 0, last_login_at: sql`now()` })
      .where('id', '=', user.id)
      .execute();
    await endSessions(trx, { deviceId: request.device!.id }, 'user_switch');
    const opened = await openSession(trx, deps, {
      user,
      device: request.device!,
      stage: 'full',
      method: 'pin',
      clientIp: request.ip,
    });
    await recordEvent(trx, 'auth.signed_in', {
      ...userEntity(user.id),
      data: { method: 'pin', stage: 'full', sessionId: opened.id },
    });
    return { token: opened.token, session: opened.session, user: userView(user) };
  });
}

/** The second step for password + 2-step users: the 6-digit code, or one recovery code. */
export async function verifySecondFactor(
  deps: AppDeps,
  request: FastifyRequest,
  body: SecondFactorRequest,
): Promise<SignInResponse> {
  rateCheck(deps, request);
  const auth = request.auth!;
  const user = await selectUser(deps).where('id', '=', auth.userId).executeTakeFirstOrThrow();
  const context = contextOf(request);

  let accepted:
    { method: 'password_totp'; step: bigint } | { method: 'recovery_code'; codeId: bigint } | null =
    null;
  if (user.locked_minutes === 0 && user.totp_enabled && user.totp_secret_enc) {
    if ('code' in body) {
      const secret = deps.secretBox.open(user.totp_secret_enc, totpAad(user.id)).toString('utf8');
      const step = verifyTotp(secret, body.code, user.totp_last_step);
      if (step !== null) accepted = { method: 'password_totp', step };
    } else {
      const typed = normalizeCode(body.recoveryCode);
      const codes = await deps.db
        .selectFrom('auth.recovery_codes')
        .select(['id', 'code_hash'])
        .where('user_id', '=', user.id)
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .execute();
      for (const code of codes) {
        if (await deps.hasher.verify(code.code_hash, typed)) {
          accepted = { method: 'recovery_code', codeId: code.id };
          break;
        }
      }
      if (codes.length === 0) await deps.hasher.verifyOrDummy(null, typed);
    }
  }

  if (!accepted) {
    const lockedMinutes = await withBusinessTx(deps.db, context, async (trx) => {
      const minutes =
        user.locked_minutes > 0
          ? user.locked_minutes
          : await passwordFailed(trx, deps, user.id, 'second_factor');
      if (minutes !== null) {
        await endSessions(trx, { userId: user.id, deviceId: request.device!.id }, 'locked_out');
      }
      return minutes;
    });
    if (lockedMinutes !== null) throw lockedError(lockedMinutes);
    throw new AppError('INVALID_TWO_STEP_CODE', 'Wrong 2-step code');
  }

  const result = accepted;
  return withBusinessTx(deps.db, context, async (trx) => {
    // Claim the code atomically: if the same code arrives twice at once, only one wins.
    const claimed =
      result.method === 'password_totp'
        ? await trx
            .updateTable('auth.users')
            .set({ totp_last_step: result.step })
            .where('id', '=', user.id)
            .where((eb) =>
              eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', result.step)]),
            )
            .executeTakeFirst()
        : await trx
            .updateTable('auth.recovery_codes')
            .set({ used_at: sql`now()` })
            .where('id', '=', result.codeId)
            .where('used_at', 'is', null)
            .where('revoked_at', 'is', null)
            .executeTakeFirst();
    if (claimed.numUpdatedRows === 0n) {
      throw new AppError('INVALID_TWO_STEP_CODE', 'Code already used');
    }
    await trx
      .updateTable('auth.users')
      .set({ failed_login_count: 0, last_login_at: sql`now()` })
      .where('id', '=', user.id)
      .execute();
    if (result.method === 'recovery_code') {
      await recordEvent(trx, 'auth.recovery_code_used', userEntity(user.id));
    }
    await endSessions(
      trx,
      { deviceId: request.device!.id, exceptId: auth.sessionId },
      'user_switch',
    );
    await endSessions(trx, { userId: user.id, deviceId: request.device!.id }, 'upgraded');
    const opened = await openSession(trx, deps, {
      user,
      device: request.device!,
      stage: 'full',
      method: result.method,
      clientIp: request.ip,
    });
    await recordEvent(trx, 'auth.signed_in', {
      ...userEntity(user.id),
      data: { method: result.method, stage: 'full', sessionId: opened.id },
    });
    return { token: opened.token, session: opened.session, user: userView(user) };
  });
}

// ---------------------------------------------------------------------------------------------
// 2-step setup (first time, or again after a recovery code)
// ---------------------------------------------------------------------------------------------

export function startTwoStep(request: FastifyRequest): TwoStepStartResponse {
  const auth = request.auth!;
  if (auth.pending !== 'two_step_setup') {
    throw new AppError('PERMISSION_DENIED', '2-step setup is not pending for this session');
  }
  const secret = newTotpSecret();
  for (const [id, entry] of pendingTwoStep)
    if (entry.expires < Date.now()) pendingTwoStep.delete(id);
  pendingTwoStep.set(auth.sessionId, { secret, expires: Date.now() + TWO_STEP_SETUP_MS });
  return { secret, uri: totpUri(secret, auth.username) };
}

export async function confirmTwoStep(
  deps: AppDeps,
  request: FastifyRequest,
  code: string,
): Promise<TwoStepConfirmResponse> {
  const auth = request.auth!;
  const pending = pendingTwoStep.get(auth.sessionId);
  if (auth.pending !== 'two_step_setup' || !pending || pending.expires < Date.now()) {
    pendingTwoStep.delete(auth.sessionId);
    throw new AppError('INVALID_TWO_STEP_CODE', 'No 2-step setup in progress');
  }
  const step = verifyTotp(pending.secret, code, null);
  if (step === null) throw new AppError('INVALID_TWO_STEP_CODE', 'Setup code does not match');

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode());
  const hashes = await Promise.all(codes.map((c) => deps.hasher.hash(normalizeCode(c))));
  const response = await withBusinessTx(deps.db, contextOf(request), async (trx) => {
    const user = await trx
      .updateTable('auth.users')
      .set({
        totp_secret_enc: deps.secretBox.seal(
          Buffer.from(pending.secret, 'utf8'),
          totpAad(auth.userId),
        ),
        totp_enabled: true,
        totp_last_step: step,
      })
      .where('id', '=', auth.userId)
      .returning([...USER_COLUMNS])
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('auth.recovery_codes')
      .set({ revoked_at: sql`now()` })
      .where('user_id', '=', auth.userId)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .execute();
    await trx
      .insertInto('auth.recovery_codes')
      .values(hashes.map((code_hash) => ({ user_id: auth.userId, code_hash }) as never))
      .execute();
    await recordEvent(trx, 'auth.two_step_enabled', {
      ...userEntity(auth.userId),
      data: { recoveryCodes: RECOVERY_CODE_COUNT },
    });
    await endSessions(trx, { userId: auth.userId, deviceId: request.device!.id }, 'upgraded');
    const opened = await openSession(trx, deps, {
      user,
      device: request.device!,
      stage: 'full',
      method: 'password_totp',
      clientIp: request.ip,
    });
    return { token: opened.token, session: opened.session, user: userView(user) };
  });
  pendingTwoStep.delete(auth.sessionId);
  return { ...response, recoveryCodes: codes };
}

// ---------------------------------------------------------------------------------------------
// Own password and PIN
// ---------------------------------------------------------------------------------------------

async function sessionView(deps: AppDeps, request: FastifyRequest): Promise<SessionView> {
  const auth = request.auth!;
  const row = await deps.db
    .selectFrom('auth.sessions as s')
    .innerJoin('auth.users as u', 'u.id', 's.user_id')
    .select([
      's.stage',
      's.auth_method',
      's.expires_at',
      's.idle_timeout_sec',
      's.locked_at',
      ...USER_COLUMNS.map((c) => `u.${c}` as const),
    ])
    .where('s.id', '=', auth.sessionId)
    .executeTakeFirstOrThrow();
  return {
    stage: row.stage as SessionView['stage'],
    authMethod: row.auth_method as SessionView['authMethod'],
    pending:
      row.stage === 'full' ? pendingFor(row, row.auth_method as SessionView['authMethod']) : null,
    locked: row.locked_at !== null,
    expiresAt: row.expires_at.toISOString(),
    idleTimeoutSeconds: row.idle_timeout_sec,
  };
}

/**
 * Checks the signed-in user's own current password or PIN (unlock, changes). A wrong one counts
 * towards the lockout or the PIN block; when that locks the user, their session here ends.
 */
async function checkOwnSecret(
  deps: AppDeps,
  request: FastifyRequest,
  secret: string,
  step: string,
): Promise<void> {
  rateCheck(deps, request);
  const auth = request.auth!;
  const user = await selectUser(deps).where('id', '=', auth.userId).executeTakeFirstOrThrow();
  const usesPin = user.sign_in_method === 'pin';
  const ok = usesPin
    ? user.pin_blocked_at === null &&
      (await deps.hasher.verifyOrDummy(user.pin_hash, normalizePin(secret)))
    : user.locked_minutes === 0 && (await deps.hasher.verifyOrDummy(user.password_hash, secret));
  if (ok) return;
  const outcome = await withBusinessTx(deps.db, contextOf(request), async (trx) => {
    let stop: 'locked' | 'blocked' | null = null;
    let minutes = 0;
    if (usesPin) {
      if (user.pin_blocked_at !== null || (await pinFailed(trx, deps, user.id, step)))
        stop = 'blocked';
    } else {
      const locked =
        user.locked_minutes > 0
          ? user.locked_minutes
          : await passwordFailed(trx, deps, user.id, step);
      if (locked !== null) {
        stop = 'locked';
        minutes = locked;
      }
    }
    if (stop) await endSessions(trx, { userId: user.id }, 'locked_out');
    return { stop, minutes };
  });
  if (outcome.stop === 'blocked') throw new AppError('PIN_BLOCKED', 'PIN blocked');
  if (outcome.stop === 'locked') throw lockedError(outcome.minutes);
  throw new AppError(usesPin ? 'INVALID_PIN' : 'INVALID_CREDENTIALS', 'Wrong own secret');
}

export async function changePassword(
  deps: AppDeps,
  request: FastifyRequest,
  body: ChangePasswordRequest,
): Promise<SessionView> {
  const auth = request.auth!;
  if (auth.signInMethod === 'pin') {
    throw new AppError('PERMISSION_DENIED', 'PIN users have no password');
  }
  await checkOwnSecret(deps, request, body.currentPassword, 'change_password');
  const problems: string[] = checkPassword(body.newPassword, {
    minLength: await deps.settings.number('security.password_min_length'),
    username: auth.username,
  });
  if (body.newPassword.normalize('NFC') === body.currentPassword.normalize('NFC')) {
    problems.push('same_as_current');
  }
  if (problems.length > 0) {
    throw new AppError('PASSWORD_REJECTED', 'New password refused', {
      problems,
      minLength: await deps.settings.number('security.password_min_length'),
    });
  }
  const hash = await deps.hasher.hash(body.newPassword);
  await withBusinessTx(deps.db, contextOf(request), async (trx) => {
    await trx
      .updateTable('auth.users')
      .set({ password_hash: hash, password_changed_at: sql`now()`, must_change_password: false })
      .where('id', '=', auth.userId)
      .execute();
    await recordEvent(trx, 'auth.password_changed', userEntity(auth.userId));
    await endSessions(trx, { userId: auth.userId, exceptId: auth.sessionId }, 'credential_changed');
  });
  return sessionView(deps, request);
}

export async function changePin(
  deps: AppDeps,
  request: FastifyRequest,
  body: ChangePinRequest,
): Promise<SessionView> {
  const auth = request.auth!;
  await checkOwnSecret(deps, request, body.current, 'change_pin');
  const user = await selectUser(deps).where('id', '=', auth.userId).executeTakeFirstOrThrow();
  if (user.pin_blocked_at !== null) throw new AppError('PIN_BLOCKED', 'PIN blocked');
  const pin = normalizePin(body.newPin);
  const problems: string[] = checkPin(pin);
  if (problems.length === 0 && user.pin_hash && (await deps.hasher.verify(user.pin_hash, pin))) {
    problems.push('same_as_current');
  }
  if (problems.length > 0) throw new AppError('PIN_REJECTED', 'New PIN refused', { problems });
  const hash = await deps.hasher.hash(pin);
  await withBusinessTx(deps.db, contextOf(request), async (trx) => {
    await trx
      .updateTable('auth.users')
      .set({ pin_hash: hash, pin_must_change: false, pin_failed_count: 0 })
      .where('id', '=', auth.userId)
      .execute();
    await recordEvent(trx, 'auth.pin_changed', userEntity(auth.userId));
    if (auth.signInMethod === 'pin') {
      await endSessions(
        trx,
        { userId: auth.userId, exceptId: auth.sessionId },
        'credential_changed',
      );
    }
  });
  return sessionView(deps, request);
}

// ---------------------------------------------------------------------------------------------
// Lock, unlock, sign out, who am I
// ---------------------------------------------------------------------------------------------

export async function lock(deps: AppDeps, request: FastifyRequest): Promise<SessionView> {
  const auth = request.auth!;
  if (!auth.locked) {
    await withBusinessTx(deps.db, contextOf(request), async (trx) => {
      await trx
        .updateTable('auth.sessions')
        .set({ locked_at: sql`now()` })
        .where('id', '=', auth.sessionId)
        .execute();
      await recordEvent(trx, 'auth.session_locked', {
        entityType: 'auth.sessions',
        entityId: auth.sessionId,
        data: { reason: 'manual' },
      });
    });
  }
  return sessionView(deps, request);
}

export async function unlock(
  deps: AppDeps,
  request: FastifyRequest,
  secret: string,
): Promise<SessionView> {
  const auth = request.auth!;
  await checkOwnSecret(deps, request, secret, 'unlock');
  await withBusinessTx(deps.db, contextOf(request), async (trx) => {
    await trx
      .updateTable('auth.sessions')
      .set({ locked_at: null, last_activity_at: sql`now()` })
      .where('id', '=', auth.sessionId)
      .execute();
    await recordEvent(trx, 'auth.session_unlocked', {
      entityType: 'auth.sessions',
      entityId: auth.sessionId,
    });
  });
  return sessionView(deps, request);
}

export async function signOut(deps: AppDeps, request: FastifyRequest): Promise<void> {
  const auth = request.auth!;
  pendingTwoStep.delete(auth.sessionId);
  await withBusinessTx(deps.db, contextOf(request), (trx) =>
    endSessions(trx, { userId: auth.userId, deviceId: request.device!.id }, 'logout'),
  );
}

export async function me(deps: AppDeps, request: FastifyRequest): Promise<MeResponse> {
  const auth = request.auth!;
  const [user, device, permissions, session] = await Promise.all([
    deps.db
      .selectFrom('auth.users')
      .select([...USER_COLUMNS])
      .where('id', '=', auth.userId)
      .executeTakeFirstOrThrow(),
    deps.db
      .selectFrom('auth.devices')
      .select('name')
      .where('id', '=', request.device!.id)
      .executeTakeFirstOrThrow(),
    permissionsOf(deps.db, auth.userId),
    sessionView(deps, request),
  ]);
  return {
    session,
    user: userView(user),
    device: deviceView(request.device!, device.name),
    permissions: [...permissions].sort(),
  };
}
