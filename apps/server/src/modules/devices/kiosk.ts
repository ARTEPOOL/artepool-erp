/**
 * The POS kiosk lock (decisions 0082, 0083, 0089, 0091). The state lives here on the server,
 * never on the POS PC: on unless the owner turned it off (15 minutes, 1 hour or until turned back
 * on) or the owner is signed in on that PC (until they sign out or lock the screen). The owner
 * changes it from Settings with a reason and a fresh 2-step code, or by typing the current code
 * on the PC's lock screen (15 minutes; 5 wrong codes in 15 minutes close that door for 15
 * minutes). Every change and every attempt to leave the app is audited and alerts the owner. PIN
 * sign-in, shifts and permissions never depend on the lock.
 */
import type { FastifyRequest } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  KIOSK_ALERT_TYPES,
  type KioskAlertsResponse,
  type KioskAlertType,
  type KioskCodeUnlockRequest,
  type KioskEventRequest,
  type KioskLock,
  type KioskStateResponse,
  type SetKioskLockRequest,
} from '@artepool/shared/contracts';
import { recordEvent } from '../../platform/audit/events';
import { verifyTotp } from '../../platform/auth/totp';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { withBusinessTx } from '../../platform/db/tx';
import { AppError } from '../../platform/errors/app-error';
import { contextOf } from '../../platform/http/context';
import type { AppDeps } from '../../platform/http/deps';
import { isOwner } from '../auth/owner';
import { rateCheck, totpAad } from '../auth/service';

type Db = Kysely<DB> | Transaction<DB>;

const CODE_MINUTES = 15;
const MAX_CODE_FAILURES = 5;

/** A PC's lock now (the database's own rule, `auth.kiosk_state`). */
export async function kioskLockOf(
  db: Db,
  deviceId: bigint,
): Promise<KioskLock & { changeId: bigint | null }> {
  const { rows } = await sql<{
    locked: boolean;
    owner_signed_in: boolean;
    change_id: string | null;
    switched_off: boolean | null;
    off_until: Date | null;
  }>`
    SELECT s.locked, s.owner_signed_in, s.change_id::text,
           NOT k.lock_on AND (k.off_until IS NULL OR k.off_until > now()) AS switched_off,
           k.off_until
      FROM auth.kiosk_state(${deviceId}) s
      LEFT JOIN auth.kiosk_lock_changes k ON k.id = s.change_id`.execute(db);
  const r = rows[0]!;
  const switchedOff = r.switched_off === true;
  return {
    locked: r.locked,
    switchedOff,
    offUntil: switchedOff ? (r.off_until?.toISOString() ?? null) : null,
    ownerSignedIn: r.owner_signed_in,
    changeId: r.change_id === null ? null : BigInt(r.change_id),
  };
}

/** The lock as the screens see it (without the internal change id). */
export function publicLock({
  changeId: _changeId,
  ...lock
}: KioskLock & { changeId: bigint | null }): KioskLock {
  return lock;
}

async function alert(
  trx: Transaction<DB>,
  type: 'kiosk_lock_off' | 'kiosk_lock_on' | 'kiosk_exit_attempt' | 'kiosk_code_blocked',
  deviceId: bigint,
  dedupe: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  await sql`INSERT INTO sys.alerts (alert_type, severity, entity_type, entity_id, params, dedupe_key)
            VALUES (${type}, ${type === 'kiosk_lock_on' ? 'info' : 'warning'}, 'auth.devices',
                    ${deviceId.toString()}, ${JSON.stringify({ deviceId: deviceId.toString(), ...params })}::jsonb,
                    ${dedupe})
            ON CONFLICT (dedupe_key) WHERE acknowledged_at IS NULL DO NOTHING`.execute(trx);
}

/**
 * This PC's mode and lock, polled by the app. A timed "off" that has just run out raises the
 * "back on" alert once (its change id keeps it from repeating).
 */
export async function kioskState(
  deps: AppDeps,
  request: FastifyRequest,
): Promise<KioskStateResponse> {
  const device = request.device!;
  if (device.kind !== 'pos') {
    return {
      isPos: false,
      locked: false,
      switchedOff: false,
      offUntil: null,
      ownerSignedIn: false,
    };
  }
  const lock = await kioskLockOf(deps.db, device.id);
  if (lock.locked && lock.changeId !== null) {
    const last = await deps.db
      .selectFrom('auth.kiosk_lock_changes')
      .select(['lock_on', 'off_until'])
      .where('id', '=', lock.changeId)
      .executeTakeFirstOrThrow();
    const dedupe = `kiosk_lock_on:${lock.changeId}`;
    // Raised once per timed "off", even after it was acknowledged: a cheap read on every poll.
    const raised =
      !last.lock_on && last.off_until !== null
        ? await deps.db
            .selectFrom('sys.alerts')
            .select('id')
            .where('dedupe_key', '=', dedupe)
            .executeTakeFirst()
        : { id: 0n };
    if (raised === undefined) {
      await withBusinessTx(deps.db, contextOf(request), (trx) =>
        alert(trx, 'kiosk_lock_on', device.id, dedupe, { code: device.code, expired: true }),
      );
    }
  }
  return { isPos: true, ...publicLock(lock) };
}

/** The current code of this person, claimed so it is never used twice (shared with sign-in). */
async function claimCode(
  deps: AppDeps,
  trx: Transaction<DB>,
  userId: bigint,
  code: string,
): Promise<boolean> {
  const user = await trx
    .selectFrom('auth.users')
    .select(['totp_enabled', 'totp_secret_enc', 'totp_last_step', 'is_active'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user?.is_active || !user.totp_enabled || user.totp_secret_enc === null) return false;
  const step = verifyTotp(
    deps.secretBox.open(user.totp_secret_enc, totpAad(userId)).toString('utf8'),
    code,
    user.totp_last_step,
  );
  if (step === null) return false;
  const claimed = await trx
    .updateTable('auth.users')
    .set({ totp_last_step: step })
    .where('id', '=', userId)
    .where((eb) => eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', step)]))
    .executeTakeFirst();
  return claimed.numUpdatedRows > 0n;
}

async function posDevice(db: Db, deviceId: bigint) {
  const d = await db
    .selectFrom('auth.devices')
    .select(['id', 'code', 'device_kind', 'status'])
    .where('id', '=', deviceId)
    .executeTakeFirst();
  if (!d) throw new AppError('NOT_FOUND', 'No such device');
  if (d.device_kind !== 'pos' || d.status !== 'active') {
    throw new AppError('VALIDATION_FAILED', 'The kiosk lock exists only on active POS PCs', {
      part: 'params',
      issues: [{ path: ['id'], code: 'not_pos' }],
    });
  }
  return d;
}

/** Settings → Devices: the owner turns a POS PC's lock on or off (decision 0089). */
export async function setKioskLock(
  deps: AppDeps,
  trx: Transaction<DB>,
  request: FastifyRequest,
  deviceId: bigint,
  body: SetKioskLockRequest,
): Promise<KioskLock> {
  const userId = request.auth!.userId;
  if (!(await isOwner(trx, userId))) {
    throw new AppError('PERMISSION_DENIED', 'Only the owner changes the kiosk lock', {
      permission: 'owner',
    });
  }
  const device = await posDevice(trx, deviceId);
  rateCheck(deps, request);
  if (!(await claimCode(deps, trx, userId, body.code))) {
    throw new AppError('INVALID_TWO_STEP_CODE', 'Wrong or used 2-step code');
  }
  const offUntil =
    body.on || body.minutes === null
      ? null
      : sql<Date>`now() + make_interval(mins => ${body.minutes})`;
  const row = await trx
    .insertInto('auth.kiosk_lock_changes')
    .values(
      stamped('auth.kiosk_lock_changes', {
        device_id: device.id,
        lock_on: body.on,
        off_until: offUntil,
        via: 'settings',
        reason: body.reason,
      }),
    )
    .returning(['id'])
    .executeTakeFirstOrThrow();
  await alert(
    trx,
    body.on ? 'kiosk_lock_on' : 'kiosk_lock_off',
    device.id,
    `kiosk_lock_${body.on ? 'on' : 'off'}:${row.id}`,
    { code: device.code, minutes: body.minutes, via: 'settings' },
  );
  return publicLock(await kioskLockOf(trx, device.id));
}

/** The lock screen's fallback: the owner's current code, 15 minutes, limited tries (0083, 0091). */
export async function unlockWithOwnerCode(
  deps: AppDeps,
  request: FastifyRequest,
  body: KioskCodeUnlockRequest,
): Promise<KioskLock> {
  const device = request.device!;
  if (device.kind !== 'pos') {
    throw new AppError('VALIDATION_FAILED', 'Only a POS PC has a kiosk lock', {
      part: 'body',
      issues: [{ path: ['code'], code: 'not_pos' }],
    });
  }
  rateCheck(deps, request);
  const failures = await deps.db
    .selectFrom('auth.kiosk_code_failures')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('device_id', '=', device.id)
    .where('created_at', '>', sql<Date>`now() - interval '15 minutes'`)
    .executeTakeFirstOrThrow();
  if (failures.n >= MAX_CODE_FAILURES) {
    throw new AppError('KIOSK_CODE_BLOCKED', 'Too many wrong owner codes on this PC');
  }
  const owners = await deps.db
    .selectFrom('auth.users')
    .select('id')
    .where('is_active', '=', true)
    .where('totp_enabled', '=', true)
    .where(sql<boolean>`auth.is_owner(id)`)
    .orderBy('id')
    .execute();
  let accepted = false;
  for (const owner of owners) {
    accepted = await withBusinessTx(
      deps.db,
      contextOf(request, { userId: owner.id }),
      async (trx) => {
        if (!(await claimCode(deps, trx, owner.id, body.code))) return false;
        const row = await trx
          .insertInto('auth.kiosk_lock_changes')
          .values(
            stamped('auth.kiosk_lock_changes', {
              device_id: device.id,
              lock_on: false,
              off_until: sql<Date>`now() + make_interval(mins => ${CODE_MINUTES})`,
              via: 'owner_code',
              reason: null,
            }),
          )
          .returning(['id'])
          .executeTakeFirstOrThrow();
        await alert(trx, 'kiosk_lock_off', device.id, `kiosk_lock_off:${row.id}`, {
          code: device.code,
          minutes: CODE_MINUTES,
          via: 'owner_code',
        });
        return true;
      },
    );
    if (accepted) break;
  }
  if (!accepted) {
    await withBusinessTx(deps.db, contextOf(request), async (trx) => {
      await trx
        .insertInto('auth.kiosk_code_failures')
        .values(stamped('auth.kiosk_code_failures', { device_id: device.id }))
        .execute();
      await recordEvent(trx, 'kiosk.owner_code_failed', {
        entityType: 'auth.devices',
        entityId: device.id.toString(),
        data: { attempts: failures.n + 1 },
      });
      if (failures.n + 1 >= MAX_CODE_FAILURES) {
        await alert(trx, 'kiosk_code_blocked', device.id, `kiosk_code_blocked:${device.id}`, {
          code: device.code,
        });
      }
    });
    throw new AppError('INVALID_TWO_STEP_CODE', 'Wrong or used owner code');
  }
  return publicLock(await kioskLockOf(deps.db, device.id));
}

/** Someone tried to leave the POS app (decision 0082): audited, and the owner is alerted. */
export async function kioskEvent(
  deps: AppDeps,
  request: FastifyRequest,
  body: KioskEventRequest,
): Promise<{ ok: true }> {
  const device = request.device!;
  if (device.kind !== 'pos') return { ok: true };
  await withBusinessTx(deps.db, contextOf(request), async (trx) => {
    await recordEvent(trx, 'kiosk.exit_attempt', {
      entityType: 'auth.devices',
      entityId: device.id.toString(),
      data: { kind: body.kind },
    });
    await alert(trx, 'kiosk_exit_attempt', device.id, `kiosk_exit_attempt:${device.id}`, {
      code: device.code,
      kind: body.kind,
    });
  });
  return { ok: true };
}

/** The latest kiosk alerts, for the owner (Settings → Devices and the dashboard, 0082). */
export async function kioskAlerts(
  db: Db,
  userId: bigint,
  limit = 30,
): Promise<KioskAlertsResponse> {
  if (!(await isOwner(db, userId))) {
    throw new AppError('PERMISSION_DENIED', 'Kiosk alerts are for the owner', {
      permission: 'owner',
    });
  }
  const rows = await db
    .selectFrom('sys.alerts as a')
    .innerJoin('auth.devices as d', (j) =>
      j.on(sql<boolean>`d.id::text = a.entity_id`).on('a.entity_type', '=', 'auth.devices'),
    )
    .select([
      'a.id',
      'a.alert_type',
      'a.created_at',
      'a.params',
      'd.id as device_id',
      'd.code',
      'd.name',
    ])
    .where('a.alert_type', 'in', [...KIOSK_ALERT_TYPES])
    .where('a.created_at', '>', sql<Date>`now() - interval '30 days'`)
    .orderBy('a.id', 'desc')
    .limit(limit)
    .execute();
  return {
    alerts: rows.map((r) => ({
      id: r.id.toString(),
      alertType: r.alert_type as KioskAlertType,
      createdAt: r.created_at.toISOString(),
      deviceId: r.device_id.toString(),
      deviceCode: r.code,
      deviceName: r.name,
      params: r.params as Record<string, unknown>,
    })),
  };
}
