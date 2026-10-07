import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { recordEvent } from '../audit/events';
import { sha256 } from '../crypto/tokens';
import { withBusinessTx } from '../db/tx';
import { AppError } from '../errors/app-error';
import { PERMISSION_CODE, type Access, type AuthInfo, type DeviceInfo } from '../http/access';
import { compareVersions, contextOf, header } from '../http/context';
import type { AppDeps } from '../http/deps';
import { BACKGROUND_HEADER, CLIENT_VERSION_HEADER, DEVICE_HEADER } from '../http/logging';
import { permissionsOf } from '../permissions';

const KEY_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;
const VERSION_FORMAT = /^\d+\.\d+\.\d+$/;

/** One row per route: what it needs. Lets tests check the whole API surface at once. */
export interface RouteAccess {
  method: string;
  url: string;
  access: Access;
}

declare module 'fastify' {
  interface FastifyInstance {
    accessTable: RouteAccess[];
  }
}

export type SessionEndReason =
  | 'logout'
  | 'expired'
  | 'revoked'
  | 'user_switch'
  | 'credential_changed'
  | 'device_revoked'
  | 'user_deactivated'
  | 'upgraded'
  | 'locked_out';

/**
 * Installs the access check on every route:
 * - at registration, a route without a declared access, or with a malformed permission code,
 *   stops the server from starting; at start-up, every declared permission must exist;
 * - on every request, the device, the session and the permission are checked before the body
 *   is even read.
 */
export function registerGuard(app: FastifyInstance, deps: AppDeps): void {
  app.decorateRequest('device', null);
  app.decorateRequest('auth', null);

  const declared = new Set<string>();
  app.decorate('accessTable', [] as RouteAccess[]);
  app.addHook('onRoute', (route) => {
    const access = route.config?.access;
    if (!access) {
      throw new Error(
        `Route ${String(route.method)} ${route.url} does not declare its access. Every route must ` +
          'say whether it is public, needs an enrolled device, a session, or a permission.',
      );
    }
    if (access.kind === 'permission') {
      if (!PERMISSION_CODE.test(access.permission)) {
        throw new Error(
          `Route ${route.url} declares a malformed permission "${access.permission}"`,
        );
      }
      declared.add(access.permission);
    }
    for (const method of [route.method].flat()) {
      app.accessTable.push({ method: String(method), url: route.url, access });
    }
  });

  app.addHook('onReady', async () => {
    if (declared.size === 0) return;
    const known = await deps.db
      .selectFrom('auth.permissions')
      .select('code')
      .where('code', 'in', [...declared])
      .execute();
    const missing = [...declared].filter((p) => !known.some((k) => k.code === p));
    if (missing.length > 0) {
      throw new Error(`Routes declare permissions that do not exist: ${missing.join(', ')}`);
    }
  });

  app.addHook('onRequest', async (request) => {
    const access = request.routeOptions.config.access;
    if (!access || access.kind === 'public') return; // no access only for the 404 handler
    request.device = await authenticateDevice(request, deps);
    if (access.kind === 'device') return;
    request.auth = await authenticateSession(request, deps, access);
    if (access.kind === 'permission') {
      await requirePermission(request, deps, access.permission);
    }
  });
}

async function authenticateDevice(request: FastifyRequest, deps: AppDeps): Promise<DeviceInfo> {
  const limiter = deps.limits.unknownDevice;
  const waitSeconds = limiter.retryAfter(request.ip);
  if (waitSeconds > 0) {
    throw new AppError('RATE_LIMITED', 'Too many unknown device keys', { seconds: waitSeconds });
  }
  const key = header(request, DEVICE_HEADER);
  const row =
    key && KEY_FORMAT.test(key)
      ? await deps.db
          .selectFrom('auth.devices')
          .select([
            'id',
            'code',
            'device_kind',
            'branch_id',
            'status',
            'key_expires_at',
            sql<boolean>`key_expires_at <= now()`.as('key_expired'),
          ])
          .where('key_hash', '=', sha256(key))
          .executeTakeFirst()
      : undefined;
  if (!row) {
    limiter.hit(request.ip);
    throw new AppError('DEVICE_NOT_ENROLLED', 'Unknown or missing device key');
  }
  if (row.status === 'revoked')
    throw new AppError('DEVICE_REVOKED', `Device ${row.code} is revoked`);
  if (row.key_expired) throw new AppError('DEVICE_KEY_EXPIRED', `Device ${row.code} key expired`);

  const version = header(request, CLIENT_VERSION_HEADER);
  const minVersion = await deps.settings.text('client.min_version');
  if (!version || !VERSION_FORMAT.test(version) || compareVersions(version, minVersion) < 0) {
    throw new AppError('CLIENT_OUTDATED', `Client ${version ?? '?'} < ${minVersion}`, {
      minVersion,
    });
  }

  await sql`
    INSERT INTO auth.device_activity (device_id, last_seen_at, last_ip, app_version)
    VALUES (${row.id}, now(), ${request.ip}::inet, ${version})
    ON CONFLICT (device_id) DO UPDATE
       SET last_seen_at = now(), last_ip = EXCLUDED.last_ip, app_version = EXCLUDED.app_version
     WHERE auth.device_activity.last_seen_at < now() - interval '30 seconds'
        OR auth.device_activity.last_ip IS DISTINCT FROM EXCLUDED.last_ip
        OR auth.device_activity.app_version IS DISTINCT FROM EXCLUDED.app_version`.execute(deps.db);

  return {
    id: row.id,
    code: row.code,
    kind: row.device_kind as DeviceInfo['kind'],
    branchId: row.branch_id,
    keyExpiresAt: row.key_expires_at,
  };
}

/** Ends a session with a reason and writes the matching audit event, in one transaction. */
export async function endSession(
  deps: AppDeps,
  request: FastifyRequest,
  session: { id: bigint; userId: bigint },
  reason: SessionEndReason,
): Promise<void> {
  await withBusinessTx(
    deps.db,
    contextOf(request, { userId: session.userId, sessionId: session.id }),
    async (trx) => {
      const ended = await trx
        .updateTable('auth.sessions')
        .set({ ended_at: sql`now()`, end_reason: reason })
        .where('id', '=', session.id)
        .where('ended_at', 'is', null)
        .executeTakeFirst();
      if (ended.numUpdatedRows > 0n) {
        await recordEvent(trx, 'auth.session_ended', {
          entityType: 'auth.sessions',
          entityId: session.id,
          data: { reason },
        });
      }
    },
  );
}

async function authenticateSession(
  request: FastifyRequest,
  deps: AppDeps,
  access: Exclude<Access, { kind: 'public' } | { kind: 'device' }>,
): Promise<AuthInfo> {
  const device = request.device!;
  const token = BEARER.exec(header(request, 'authorization') ?? '')?.[1];
  if (!token) throw new AppError('SESSION_REQUIRED', 'No session token');

  const row = await deps.db
    .selectFrom('auth.sessions as s')
    .innerJoin('auth.users as u', 'u.id', 's.user_id')
    .select([
      's.id',
      's.user_id',
      's.device_id',
      's.stage',
      's.auth_method',
      's.locked_at',
      's.ended_at',
      'u.username',
      'u.is_active',
      'u.sign_in_method',
      'u.must_change_password',
      'u.pin_must_change',
      'u.totp_enabled',
      sql<boolean>`s.expires_at <= now()`.as('expired'),
      sql<boolean>`s.last_activity_at + make_interval(secs => s.idle_timeout_sec) <= now()`.as(
        'idle',
      ),
      sql<boolean>`s.last_activity_at < now() - interval '15 seconds'`.as('stale'),
    ])
    .where('s.token_hash', '=', sha256(token))
    .executeTakeFirst();

  if (!row || row.ended_at !== null)
    throw new AppError('SESSION_EXPIRED', 'Unknown or ended session');
  const session = { id: row.id, userId: row.user_id };
  if (row.device_id !== device.id) {
    // A token used from another PC was copied: end it.
    await endSession(deps, request, session, 'revoked');
    throw new AppError('SESSION_EXPIRED', 'Session used from another device');
  }
  if (row.expired) {
    await endSession(deps, request, session, 'expired');
    throw new AppError('SESSION_EXPIRED', 'Session expired');
  }
  if (!row.is_active) {
    await endSession(deps, request, session, 'user_deactivated');
    throw new AppError('SESSION_EXPIRED', 'User deactivated');
  }

  const wantStage = access.kind === 'session' ? (access.stage ?? 'full') : 'full';
  if (row.stage !== wantStage) {
    if (row.stage === 'second_factor') {
      throw new AppError('SECOND_FACTOR_REQUIRED', 'The 2-step code is still needed');
    }
    throw new AppError('PERMISSION_DENIED', 'This step does not apply to a full session');
  }

  let locked = row.locked_at !== null;
  if (row.stage === 'full' && !locked && row.idle) {
    await withBusinessTx(
      deps.db,
      contextOf(request, { userId: row.user_id, sessionId: row.id }),
      async (trx) => {
        await trx
          .updateTable('auth.sessions')
          .set({ locked_at: sql`now()` })
          .where('id', '=', row.id)
          .execute();
        await recordEvent(trx, 'auth.session_locked', {
          entityType: 'auth.sessions',
          entityId: row.id,
          data: { reason: 'idle' },
        });
      },
    );
    locked = true;
  }
  const allowLocked = access.kind === 'session' && access.allowLocked === true;
  if (locked && !allowLocked) throw new AppError('SESSION_LOCKED', 'Session is locked');

  const mustChange = row.sign_in_method === 'pin' ? row.pin_must_change : row.must_change_password;
  const pending: AuthInfo['pending'] = mustChange
    ? 'credential_change'
    : row.sign_in_method === 'password_totp' && !row.totp_enabled
      ? 'two_step_setup'
      : null;
  const allowPending = access.kind === 'session' && access.allowPending === true;
  if (pending && row.stage === 'full' && !allowPending) {
    throw new AppError(
      pending === 'credential_change' ? 'CREDENTIAL_CHANGE_REQUIRED' : 'TWO_STEP_SETUP_REQUIRED',
      `Pending: ${pending}`,
    );
  }

  // Background calls (status polling) do not count as the person being active.
  if (!locked && row.stale && header(request, BACKGROUND_HEADER) !== '1') {
    await deps.db
      .updateTable('auth.sessions')
      .set({ last_activity_at: sql`now()` })
      .where('id', '=', row.id)
      .where('ended_at', 'is', null)
      .execute();
  }

  return {
    sessionId: row.id,
    userId: row.user_id,
    username: row.username,
    signInMethod: row.sign_in_method as AuthInfo['signInMethod'],
    authMethod: row.auth_method as AuthInfo['authMethod'],
    stage: row.stage,
    locked,
    pending,
    permissions: new Set(),
  };
}

async function requirePermission(
  request: FastifyRequest,
  deps: AppDeps,
  permission: string,
): Promise<void> {
  const auth = request.auth!;
  auth.permissions = await permissionsOf(deps.db, auth.userId);
  if (auth.permissions.has(permission)) return;
  await withBusinessTx(deps.db, contextOf(request), (trx) =>
    recordEvent(trx, 'auth.permission_denied', {
      data: { permission, method: request.method, route: request.routeOptions.url },
    }),
  );
  throw new AppError('PERMISSION_DENIED', `Missing permission ${permission}`, { permission });
}
