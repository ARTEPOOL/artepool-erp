import { sql, type Transaction } from 'kysely';
import type {
  AuthMethod,
  DeviceView,
  PendingStep,
  SessionStage,
  SessionView,
  UserView,
} from '@artepool/shared/contracts';
import { recordEvent } from '../../platform/audit/events';
import { pendingStep, type SessionEndReason } from '../../platform/auth/guard';
import { newToken, sha256 } from '../../platform/crypto/tokens';
import type { DB } from '../../platform/db/schema.generated';
import type { DeviceInfo } from '../../platform/http/access';
import type { AppDeps } from '../../platform/http/deps';

/** A session waiting for the 2-step code lasts 5 minutes at most. */
const SECOND_FACTOR_SECONDS = 300;

export interface UserRow {
  id: bigint;
  username: string;
  display_name_ar: string;
  display_name_en: string;
  language: string;
  sign_in_method: string;
  must_change_password: boolean;
  pin_must_change: boolean;
  totp_enabled: boolean;
}

export const USER_COLUMNS = [
  'id',
  'username',
  'display_name_ar',
  'display_name_en',
  'language',
  'sign_in_method',
  'must_change_password',
  'pin_must_change',
  'totp_enabled',
] as const;

export function userView(user: UserRow): UserView {
  return {
    id: user.id.toString(),
    username: user.username,
    displayNameAr: user.display_name_ar,
    displayNameEn: user.display_name_en,
    language: user.language === 'en' ? 'en' : 'ar',
    signInMethod: user.sign_in_method as UserView['signInMethod'],
  };
}

export function deviceView(device: DeviceInfo, name: string): DeviceView {
  return { id: device.id.toString(), code: device.code, name, kind: device.kind };
}

/** What the user must do first, if anything (same rule as the request guard). */
export function pendingFor(user: UserRow, method: AuthMethod): PendingStep {
  return pendingStep({ ...user, auth_method: method });
}

/**
 * Idle lock, per kind of PC (settings). 0 turns it off (decision 0079): the idle limit is then
 * the session's whole length, so the screen never locks before the session ends.
 */
export async function idleSecondsFor(deps: AppDeps, device: DeviceInfo): Promise<number> {
  const key =
    device.kind === 'pos' ? 'security.idle_lock_minutes.pos' : 'security.idle_lock_minutes.office';
  const minutes = await deps.settings.number(key);
  if (minutes === 0) return (await deps.settings.number('security.session_max_hours')) * 3600;
  return minutes * 60;
}

/**
 * Ends every open session on this PC (one person at a time per PC) or of this user (after a
 * password change), each with an audit event.
 */
export async function endSessions(
  trx: Transaction<DB>,
  where: { deviceId?: bigint; userId?: bigint; exceptId?: bigint },
  reason: SessionEndReason,
): Promise<void> {
  let query = trx
    .updateTable('auth.sessions')
    .set({ ended_at: sql`now()`, end_reason: reason })
    .where('ended_at', 'is', null);
  if (where.deviceId !== undefined) query = query.where('device_id', '=', where.deviceId);
  if (where.userId !== undefined) query = query.where('user_id', '=', where.userId);
  if (where.exceptId !== undefined) query = query.where('id', '<>', where.exceptId);
  const ended = await query.returning(['id', 'user_id']).execute();
  for (const session of ended) {
    await recordEvent(trx, 'auth.session_ended', {
      entityType: 'auth.sessions',
      entityId: session.id,
      data: { reason, userId: session.user_id },
    });
  }
}

/** Opens a session and returns its token (shown once; only its SHA-256 is stored). */
export async function openSession(
  trx: Transaction<DB>,
  deps: AppDeps,
  input: {
    user: UserRow;
    device: DeviceInfo;
    stage: SessionStage;
    method: AuthMethod;
    clientIp: string;
  },
): Promise<{ token: string; session: SessionView; id: bigint }> {
  const token = newToken();
  const secondFactor = input.stage === 'second_factor';
  const idle = secondFactor ? SECOND_FACTOR_SECONDS : await idleSecondsFor(deps, input.device);
  const lifetime = secondFactor
    ? sql<Date>`now() + make_interval(secs => ${SECOND_FACTOR_SECONDS})`
    : sql<Date>`now() + make_interval(hours => ${await deps.settings.number('security.session_max_hours')})`;
  const row = await trx
    .insertInto('auth.sessions')
    .values({
      token_hash: sha256(token),
      user_id: input.user.id,
      device_id: input.device.id,
      stage: input.stage,
      auth_method: input.method,
      idle_timeout_sec: idle,
      expires_at: lifetime,
      client_ip: input.clientIp,
    })
    .returning(['id', 'expires_at'])
    .executeTakeFirstOrThrow();
  return {
    token,
    id: row.id,
    session: {
      stage: input.stage,
      authMethod: input.method,
      pending: secondFactor ? null : pendingFor(input.user, input.method),
      locked: false,
      expiresAt: row.expires_at.toISOString(),
      idleTimeoutSeconds: idle,
    },
  };
}
