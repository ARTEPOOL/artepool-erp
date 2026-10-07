/**
 * Enrolled PCs (decisions 0024, 0026): one-time enrollment codes, the enrollment protocol,
 * automatic key renewal, and revoking a PC with a reason.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  clientProofMessage,
  ENROLL_PROTOCOL,
  enrollTranscript,
  serverProofMessage,
  type DeviceKind,
  type DeviceListItem,
  type DevicesResponse,
  type EnrollCompleteRequest,
  type EnrollCompleteResponse,
  type EnrollHelloRequest,
  type EnrollHelloResponse,
  type EnrollmentCodeResponse,
  type RenewKeyResponse,
} from '@artepool/shared/contracts';
import { recordEvent } from '../../platform/audit/events';
import { newEnrollmentCode } from '../../platform/crypto/codes';
import { safeEqual } from '../../platform/crypto/tokens';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { withBusinessTx } from '../../platform/db/tx';
import { AppError } from '../../platform/errors/app-error';
import { contextOf } from '../../platform/http/context';
import type { AppDeps } from '../../platform/http/deps';
import { endSessions } from '../auth/sessions';
import { caFingerprint, deriveCodeKey, proof } from './enrollment-crypto';

/** Keys are renewed when less than this many days are left. */
const RENEW_WITHIN_DAYS = 30;

const fromB64 = (text: string): Buffer => Buffer.from(text, 'base64url');

// ---------------------------------------------------------------------------------------------
// Enrollment codes
// ---------------------------------------------------------------------------------------------

/**
 * Creates a new one-time code (cancelling any open one) inside the caller's transaction.
 * Only an Argon2id-derived key is stored; the code is returned once, for the person to read.
 */
export async function createEnrollmentCode(
  trx: Transaction<DB>,
  deps: Pick<AppDeps, 'settings'>,
  origin: 'settings' | 'console',
): Promise<{ code: string; expiresAt: Date }> {
  await trx
    .updateTable('auth.enrollment_codes')
    .set({ cancelled_at: sql`now()`, cancel_reason: 'replaced' })
    .where('used_at', 'is', null)
    .where('cancelled_at', 'is', null)
    .execute();
  const code = newEnrollmentCode();
  const salt = randomBytes(16);
  const minutes = await deps.settings.number('security.enrollment_code_minutes');
  const row = await trx
    .insertInto('auth.enrollment_codes')
    .values(
      stamped('auth.enrollment_codes', {
        origin,
        key_salt: salt,
        code_key: await deriveCodeKey(code, salt),
        expires_at: sql<Date>`now() + make_interval(mins => ${minutes})`,
      }),
    )
    .returning(['id', 'expires_at'])
    .executeTakeFirstOrThrow();
  await recordEvent(trx, 'auth.enrollment_code_created', {
    entityType: 'auth.enrollment_codes',
    entityId: row.id,
    data: { origin, minutes },
  });
  return { code, expiresAt: row.expires_at };
}

export async function newCodeFromSettings(
  deps: AppDeps,
  trx: Transaction<DB>,
): Promise<{ body: EnrollmentCodeResponse; replay: EnrollmentCodeResponse }> {
  const created = await createEnrollmentCode(trx, deps, 'settings');
  const expiresAt = created.expiresAt.toISOString();
  return { body: { code: created.code, expiresAt }, replay: { code: null, expiresAt } };
}

function openCode(db: Kysely<DB>) {
  return db
    .selectFrom('auth.enrollment_codes')
    .select(['id', 'key_salt', 'code_key', 'created_by', 'failed_attempts', 'expires_at'])
    .where('used_at', 'is', null)
    .where('cancelled_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst();
}

function rateCheck(deps: AppDeps, request: FastifyRequest): void {
  const wait = deps.limits.enrollment.retryAfter(request.ip);
  if (wait > 0)
    throw new AppError('RATE_LIMITED', 'Too many enrollment attempts', { seconds: wait });
  deps.limits.enrollment.hit(request.ip);
}

function requireCa(deps: AppDeps): string {
  if (!deps.caCertificatePem) {
    throw new AppError('ENROLLMENT_UNAVAILABLE', 'No CA certificate configured');
  }
  return deps.caCertificatePem;
}

// ---------------------------------------------------------------------------------------------
// The enrollment protocol (packages/shared/src/contracts/enrollment.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Step 1. Without an open code the answer looks the same but carries a random proof, so
 * nobody can learn from it whether a code is open.
 */
export async function hello(
  deps: AppDeps,
  request: FastifyRequest,
  body: EnrollHelloRequest,
): Promise<EnrollHelloResponse> {
  rateCheck(deps, request);
  const ca = requireCa(deps);
  const code = await openCode(deps.db);
  const serverNonce = randomBytes(32).toString('base64url');
  const transcript = enrollTranscript(body.clientNonce, serverNonce, caFingerprint(ca));
  return {
    protocol: ENROLL_PROTOCOL,
    caCertificatePem: ca,
    serverNonce,
    keySalt: (code?.key_salt ?? randomBytes(16)).toString('base64url'),
    serverProof: code
      ? proof(code.code_key, serverProofMessage(transcript))
      : randomBytes(32).toString('base64url'),
  };
}

/** Step 3. Checks the PC's proof, then stores the PC with the hash of its own device key. */
export async function complete(
  deps: AppDeps,
  request: FastifyRequest,
  body: EnrollCompleteRequest,
): Promise<EnrollCompleteResponse> {
  rateCheck(deps, request);
  const ca = requireCa(deps);
  const code = await openCode(deps.db);
  const transcript = enrollTranscript(body.clientNonce, body.serverNonce, caFingerprint(ca));
  const expected = code ? proof(code.code_key, clientProofMessage(transcript, body)) : null;

  if (!code || !expected || !safeEqual(fromB64(expected), fromB64(body.clientProof))) {
    await withBusinessTx(
      deps.db,
      contextOf(request, { reason: 'device enrollment' }),
      async (trx) => {
        if (!code) {
          await recordEvent(trx, 'auth.enrollment_failed', { data: { reason: 'no_open_code' } });
          return;
        }
        const { failed_attempts: attempts } = await trx
          .updateTable('auth.enrollment_codes')
          .set({ failed_attempts: sql`failed_attempts + 1` })
          .where('id', '=', code.id)
          .returning('failed_attempts')
          .executeTakeFirstOrThrow();
        await recordEvent(trx, 'auth.enrollment_failed', {
          entityType: 'auth.enrollment_codes',
          entityId: code.id,
          data: { reason: 'wrong_proof', attempts },
        });
        if (attempts >= (await deps.settings.number('security.enrollment_max_attempts'))) {
          await trx
            .updateTable('auth.enrollment_codes')
            .set({ cancelled_at: sql`now()`, cancel_reason: 'too_many_attempts' })
            .where('id', '=', code.id)
            .execute();
        }
      },
    );
    throw new AppError('ENROLLMENT_FAILED', 'Enrollment proof refused');
  }

  return withBusinessTx(
    deps.db,
    contextOf(request, { reason: 'device enrollment' }),
    async (trx) => {
      const branch = await trx
        .selectFrom('sys.branches')
        .select('id')
        .where('is_active', '=', true)
        .orderBy('id')
        .executeTakeFirstOrThrow();
      const days = await deps.settings.number('security.device_key_days');
      const device = await trx
        .insertInto('auth.devices')
        .values(
          stamped('auth.devices', {
            code: body.deviceCode,
            name: body.deviceName,
            device_kind: body.deviceKind,
            branch_id: branch.id,
            key_hash: fromB64(body.deviceKeyHash),
            key_expires_at: sql<Date>`now() + make_interval(days => ${days})`,
            enrolled_by: code.created_by,
          }),
        )
        .returning(['id', 'key_expires_at'])
        .executeTakeFirstOrThrow();
      const used = await trx
        .updateTable('auth.enrollment_codes')
        .set({ used_at: sql`now()`, used_device_id: device.id })
        .where('id', '=', code.id)
        .where('used_at', 'is', null)
        .where('cancelled_at', 'is', null)
        .executeTakeFirst();
      if (used.numUpdatedRows === 0n)
        throw new AppError('ENROLLMENT_FAILED', 'Code used meanwhile');
      await recordEvent(trx, 'auth.device_enrolled', {
        entityType: 'auth.devices',
        entityId: device.id,
        data: { code: body.deviceCode, kind: body.deviceKind },
      });
      return {
        device: {
          id: device.id.toString(),
          code: body.deviceCode,
          name: body.deviceName,
          kind: body.deviceKind,
        },
        keyExpiresAt: device.key_expires_at.toISOString(),
      };
    },
  );
}

/**
 * The PC renews its own key before it expires. It sends only the hash of a key it made itself
 * and keeps both keys until the answer arrives, so a lost answer never locks it out.
 */
export async function renewKey(
  deps: AppDeps,
  request: FastifyRequest,
  newKeyHash: string,
): Promise<RenewKeyResponse> {
  const device = request.device!;
  return withBusinessTx(
    deps.db,
    contextOf(request, { reason: 'device key renewal' }),
    async (trx) => {
      const days = await deps.settings.number('security.device_key_days');
      const renewed = await trx
        .updateTable('auth.devices')
        .set({
          key_hash: fromB64(newKeyHash),
          key_expires_at: sql<Date>`now() + make_interval(days => ${days})`,
        })
        .where('id', '=', device.id)
        .where(
          'key_expires_at',
          '<',
          sql<Date>`now() + make_interval(days => ${RENEW_WITHIN_DAYS})`,
        )
        .returning('key_expires_at')
        .executeTakeFirst();
      if (renewed) {
        await recordEvent(trx, 'auth.device_key_renewed', {
          entityType: 'auth.devices',
          entityId: device.id,
        });
        return { renewed: true, keyExpiresAt: renewed.key_expires_at.toISOString() };
      }
      return { renewed: false, keyExpiresAt: device.keyExpiresAt.toISOString() };
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Settings → Devices (owner only)
// ---------------------------------------------------------------------------------------------

export async function listDevices(
  deps: AppDeps,
  request: FastifyRequest,
): Promise<DevicesResponse> {
  const [rows, open] = await Promise.all([
    deps.db
      .selectFrom('auth.devices as d')
      .leftJoin('auth.device_activity as a', 'a.device_id', 'd.id')
      .select([
        'd.id',
        'd.code',
        'd.name',
        'd.device_kind',
        'd.status',
        'd.enrolled_at',
        'd.key_expires_at',
        'd.revoked_at',
        'd.revoke_reason',
        'a.last_seen_at',
        'a.last_ip',
        'a.app_version',
      ])
      .orderBy('d.status')
      .orderBy('d.code')
      .execute(),
    openCode(deps.db),
  ]);
  const devices: DeviceListItem[] = rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    name: r.name,
    kind: r.device_kind as DeviceKind,
    status: r.status as DeviceListItem['status'],
    enrolledAt: r.enrolled_at.toISOString(),
    keyExpiresAt: r.key_expires_at.toISOString(),
    lastSeenAt: r.last_seen_at?.toISOString() ?? null,
    lastIp: r.last_ip,
    appVersion: r.app_version,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    revokeReason: r.revoke_reason,
    isCurrent: r.id === request.device!.id,
  }));
  return { devices, openCode: open ? { expiresAt: open.expires_at.toISOString() } : null };
}

export async function updateDevice(
  trx: Transaction<DB>,
  id: bigint,
  changes: { name?: string | undefined; kind?: DeviceKind | undefined },
): Promise<void> {
  const updated = await trx
    .updateTable('auth.devices')
    .set({
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.kind !== undefined ? { device_kind: changes.kind } : {}),
    })
    .where('id', '=', id)
    .executeTakeFirst();
  if (updated.numUpdatedRows === 0n) throw new AppError('NOT_FOUND', 'No such device');
}

/** Revoking is final; the PC's sessions end at once and its next request is refused. */
export async function revokeDevice(
  trx: Transaction<DB>,
  request: FastifyRequest,
  id: bigint,
  reason: string,
): Promise<void> {
  const device = await trx
    .selectFrom('auth.devices')
    .select(['id', 'device_kind', 'status'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!device) throw new AppError('NOT_FOUND', 'No such device');
  if (device.id === request.device!.id || device.device_kind === 'server') {
    throw new AppError('DEVICE_PROTECTED', 'The server and the current PC cannot be revoked here');
  }
  await trx
    .updateTable('auth.devices')
    .set({ status: 'revoked', revoke_reason: reason })
    .where('id', '=', id)
    .execute();
  await endSessions(trx, { deviceId: id }, 'device_revoked');
}
