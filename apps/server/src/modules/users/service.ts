/**
 * Settings → Users & permissions (owner only). Users are never deleted: they are deactivated
 * with a reason (decision 0026). Temporary passwords and PINs are shown once (decisions 0021,
 * 0023). The owner account is protected (decision 0025).
 */
import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  CreateRoleRequest,
  CreateUserRequest,
  PermissionInfo,
  RoleInfo,
  RoleRef,
  RolesResponse,
  SignInMethod,
  TemporaryCodeResponse,
  UpdateRoleRequest,
  UpdateUserRequest,
  UserListItem,
  UserStatus,
} from '@artepool/shared/contracts';
import { recordEvent } from '../../platform/audit/events';
import { newTemporaryPin } from '../../platform/auth/pin-policy';
import { newTemporaryPassword } from '../../platform/crypto/codes';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { AppError } from '../../platform/errors/app-error';
import type { AppDeps } from '../../platform/http/deps';
import { endSessions } from '../auth/sessions';

type Reader = Kysely<DB>;

const userEntity = (id: bigint) => ({ entityType: 'auth.users', entityId: id });

// ---------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------

async function rolesOf(db: Reader, userIds: bigint[]): Promise<Map<bigint, RoleRef[]>> {
  const out = new Map<bigint, RoleRef[]>();
  if (userIds.length === 0) return out;
  const rows = await db
    .selectFrom('auth.user_roles as ur')
    .innerJoin('auth.roles as r', 'r.id', 'ur.role_id')
    .select(['ur.user_id', 'r.id', 'r.code', 'r.name_ar', 'r.name_en'])
    .where('ur.user_id', 'in', userIds)
    .orderBy('r.id')
    .execute();
  for (const r of rows) {
    const list = out.get(r.user_id) ?? [];
    list.push({ id: r.id.toString(), code: r.code, nameAr: r.name_ar, nameEn: r.name_en });
    out.set(r.user_id, list);
  }
  return out;
}

/** All people (never SYSTEM), as Settings shows them. */
export async function listUsers(db: Reader, onlyId?: bigint): Promise<UserListItem[]> {
  let query = db
    .selectFrom('auth.users')
    .select([
      'id',
      'username',
      'display_name_ar',
      'display_name_en',
      'sign_in_method',
      'is_active',
      'last_login_at',
      'must_change_password',
      'pin_must_change',
      'pin_blocked_at',
      'approval_blocked_at',
      'deactivated_at',
      'deactivation_reason',
      sql<number>`greatest(0, ceil(extract(epoch FROM locked_until - now()) / 60))::int`.as(
        'locked_minutes',
      ),
    ])
    .where('id', '<>', 1n)
    .orderBy('is_active', 'desc')
    .orderBy('display_name_en');
  if (onlyId !== undefined) query = query.where('id', '=', onlyId);
  const rows = await query.execute();
  const roles = await rolesOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    const status: UserStatus = !r.is_active
      ? 'inactive'
      : r.locked_minutes > 0
        ? 'locked'
        : r.pin_blocked_at || r.approval_blocked_at
          ? 'pin_blocked'
          : 'active';
    const userRoles = roles.get(r.id) ?? [];
    return {
      id: r.id.toString(),
      username: r.username,
      displayNameAr: r.display_name_ar,
      displayNameEn: r.display_name_en,
      signInMethod: r.sign_in_method as SignInMethod,
      roles: userRoles,
      status,
      lockedMinutes: status === 'locked' ? r.locked_minutes : null,
      lastLoginAt: r.last_login_at?.toISOString() ?? null,
      mustChange: r.sign_in_method === 'pin' ? r.pin_must_change : r.must_change_password,
      isOwner: userRoles.some((role) => role.code === 'owner'),
      deactivatedAt: r.deactivated_at?.toISOString() ?? null,
      deactivationReason: r.deactivation_reason,
    };
  });
}

async function oneUser(db: Reader, id: bigint): Promise<UserListItem> {
  const [user] = await listUsers(db, id);
  if (!user) throw new AppError('NOT_FOUND', 'No such user');
  return user;
}

/** A role a user may be given from the screen: active, and never the owner role. */
async function assignableRole(trx: Transaction<DB>, roleId: string) {
  const role = await trx
    .selectFrom('auth.roles')
    .select(['id', 'code', 'requires_2fa'])
    .where('id', '=', BigInt(roleId))
    .where('is_active', '=', true)
    .executeTakeFirst();
  if (!role) {
    throw new AppError('VALIDATION_FAILED', 'Unknown or inactive role', {
      part: 'body',
      issues: [{ path: ['roleId'], code: 'unknown_role' }],
    });
  }
  if (role.code === 'owner') {
    throw new AppError('OWNER_PROTECTED', 'There is only one owner, created on the server');
  }
  return role;
}

function twoStepRequired(field: string): AppError {
  return new AppError('VALIDATION_FAILED', 'This role needs password + 2-step sign-in', {
    part: 'body',
    issues: [{ path: [field], code: 'two_step_required' }],
  });
}

/** New temporary credentials for a sign-in method, ready to store (hash) and show (plain). */
async function temporaryCredentials(deps: AppDeps, method: SignInMethod) {
  if (method === 'pin') {
    const pin = newTemporaryPin();
    return { kind: 'pin' as const, plain: pin, hash: await deps.hasher.hash(pin) };
  }
  const password = newTemporaryPassword();
  return { kind: 'password' as const, plain: password, hash: await deps.hasher.hash(password) };
}

export async function createUser(
  trx: Transaction<DB>,
  deps: AppDeps,
  body: CreateUserRequest,
): Promise<{ body: TemporaryCodeResponse; replay: TemporaryCodeResponse }> {
  const role = await assignableRole(trx, body.roleId);
  if (role.requires_2fa && body.signInMethod !== 'password_totp')
    throw twoStepRequired('signInMethod');
  const taken = await trx
    .selectFrom('auth.users')
    .select('id')
    .where(sql`lower(username)`, '=', body.username)
    .executeTakeFirst();
  if (taken) {
    throw new AppError('DUPLICATE', 'Username taken', {
      part: 'body',
      issues: [{ path: ['username'], code: 'taken' }],
    });
  }
  const temp = await temporaryCredentials(deps, body.signInMethod);
  const user = await trx
    .insertInto('auth.users')
    .values(
      stamped('auth.users', {
        username: body.username,
        display_name_ar: body.displayNameAr,
        display_name_en: body.displayNameEn,
        sign_in_method: body.signInMethod,
        ...(temp.kind === 'pin'
          ? { pin_hash: temp.hash, pin_must_change: true, password_hash: null }
          : { password_hash: temp.hash, must_change_password: true }),
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('auth.user_roles')
    .values(stamped('auth.user_roles', { user_id: user.id, role_id: role.id }))
    .execute();
  const view = await oneUser(trx, user.id);
  return {
    body: { user: view, temporaryCode: temp.plain, kind: temp.kind },
    replay: { user: view, temporaryCode: null, kind: temp.kind },
  };
}

export async function updateUser(
  trx: Transaction<DB>,
  id: bigint,
  body: UpdateUserRequest,
): Promise<UserListItem> {
  const current = await oneUser(trx, id);
  const sameRole = current.roles.length === 1 && current.roles[0]!.id === body.roleId;
  if (body.roleId !== undefined && !sameRole) {
    if (current.isOwner) throw new AppError('OWNER_PROTECTED', "The owner's role cannot change");
    const role = await assignableRole(trx, body.roleId);
    if (role.requires_2fa && current.signInMethod !== 'password_totp')
      throw twoStepRequired('roleId');
    await trx.deleteFrom('auth.user_roles').where('user_id', '=', id).execute();
    await trx
      .insertInto('auth.user_roles')
      .values(stamped('auth.user_roles', { user_id: id, role_id: role.id }))
      .execute();
  }
  const changes = {
    ...(body.displayNameAr !== undefined ? { display_name_ar: body.displayNameAr } : {}),
    ...(body.displayNameEn !== undefined ? { display_name_en: body.displayNameEn } : {}),
    ...(body.language !== undefined ? { language: body.language } : {}),
  };
  if (Object.keys(changes).length > 0) {
    await trx.updateTable('auth.users').set(changes).where('id', '=', id).execute();
  }
  return oneUser(trx, id);
}

/**
 * New temporary password or PIN (optionally switching the sign-in method). Also unlocks and
 * unblocks, and ends the user's sessions everywhere.
 */
export async function resetCredentials(
  trx: Transaction<DB>,
  deps: AppDeps,
  id: bigint,
  newMethod: SignInMethod | undefined,
): Promise<{ body: TemporaryCodeResponse; replay: TemporaryCodeResponse }> {
  const current = await oneUser(trx, id);
  if (current.isOwner) {
    throw new AppError(
      'OWNER_PROTECTED',
      'The owner changes their own password; see owner:reset-2fa',
    );
  }
  const method = newMethod ?? current.signInMethod;
  const needsTwoStep = await trx
    .selectFrom('auth.user_roles as ur')
    .innerJoin('auth.roles as r', 'r.id', 'ur.role_id')
    .select('r.id')
    .where('ur.user_id', '=', id)
    .where('r.requires_2fa', '=', true)
    .where('r.is_active', '=', true)
    .executeTakeFirst();
  if (needsTwoStep && method !== 'password_totp') throw twoStepRequired('signInMethod');

  const temp = await temporaryCredentials(deps, method);
  const keepTwoStep = method === 'password_totp' && current.signInMethod === 'password_totp';
  await trx
    .updateTable('auth.users')
    .set({
      sign_in_method: method,
      failed_login_count: 0,
      locked_until: null,
      pin_failed_count: 0,
      pin_blocked_at: null,
      ...(keepTwoStep ? {} : { totp_enabled: false, totp_secret_enc: null, totp_last_step: null }),
      ...(temp.kind === 'pin'
        ? { pin_hash: temp.hash, pin_must_change: true, password_hash: null }
        : { password_hash: temp.hash, must_change_password: true }),
    })
    .where('id', '=', id)
    .execute();
  await recordEvent(trx, 'auth.credentials_reset', {
    ...userEntity(id),
    data: { kind: temp.kind, method, methodChanged: method !== current.signInMethod },
  });
  await endSessions(trx, { userId: id }, 'credential_changed');
  const view = await oneUser(trx, id);
  return {
    body: { user: view, temporaryCode: temp.plain, kind: temp.kind },
    replay: { user: view, temporaryCode: null, kind: temp.kind },
  };
}

/** Lifts a lockout (wrong passwords), a PIN block (wrong PINs) and an approval-code block. */
export async function unlockUser(trx: Transaction<DB>, id: bigint): Promise<UserListItem> {
  await oneUser(trx, id);
  await trx
    .updateTable('auth.users')
    .set({
      locked_until: null,
      failed_login_count: 0,
      pin_blocked_at: null,
      pin_failed_count: 0,
      approval_blocked_at: null,
      approval_failed_count: 0,
    })
    .where('id', '=', id)
    .execute();
  await recordEvent(trx, 'auth.user_unlocked', userEntity(id));
  return oneUser(trx, id);
}

export async function deactivateUser(
  trx: Transaction<DB>,
  request: FastifyRequest,
  id: bigint,
  reason: string,
): Promise<UserListItem> {
  const current = await oneUser(trx, id);
  if (current.isOwner || id === request.auth!.userId) {
    throw new AppError('OWNER_PROTECTED', 'The owner account cannot be deactivated');
  }
  if (current.status !== 'inactive') {
    await trx
      .updateTable('auth.users')
      .set({ is_active: false, deactivation_reason: reason })
      .where('id', '=', id)
      .execute();
    await endSessions(trx, { userId: id }, 'user_deactivated');
  }
  return oneUser(trx, id);
}

export async function reactivateUser(trx: Transaction<DB>, id: bigint): Promise<UserListItem> {
  await oneUser(trx, id);
  await trx.updateTable('auth.users').set({ is_active: true }).where('id', '=', id).execute();
  return oneUser(trx, id);
}

// ---------------------------------------------------------------------------------------------
// Roles and permissions
// ---------------------------------------------------------------------------------------------

export async function listRoles(db: Reader): Promise<RolesResponse> {
  const [roles, links, counts, permissions] = await Promise.all([
    db.selectFrom('auth.roles').selectAll().orderBy('id').execute(),
    db.selectFrom('auth.role_permissions').select(['role_id', 'permission_code']).execute(),
    db
      .selectFrom('auth.user_roles as ur')
      .innerJoin('auth.users as u', 'u.id', 'ur.user_id')
      .select(['ur.role_id', sql<number>`count(*)::int`.as('n')])
      .where('u.is_active', '=', true)
      .groupBy('ur.role_id')
      .execute(),
    db.selectFrom('auth.permissions').selectAll().orderBy('module').orderBy('code').execute(),
  ]);
  const roleInfo: RoleInfo[] = roles.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    isSystem: r.is_system,
    isActive: r.is_active,
    requires2fa: r.requires_2fa,
    maxDiscountBp: r.max_discount_bp,
    maxDiscountFils: r.max_discount_fils.toString(),
    permissions: links
      .filter((l) => l.role_id === r.id)
      .map((l) => l.permission_code)
      .sort(),
    activeUsers: counts.find((c) => c.role_id === r.id)?.n ?? 0,
  }));
  const catalog: PermissionInfo[] = permissions.map((p) => ({
    code: p.code,
    module: p.module,
    nameAr: p.name_ar,
    nameEn: p.name_en,
    isSensitive: p.is_sensitive,
    approvable: p.approvable,
    ownerOnly: p.owner_only,
  }));
  return { roles: roleInfo, permissions: catalog };
}

async function roleById(db: Reader, id: bigint): Promise<RoleInfo> {
  const role = (await listRoles(db)).roles.find((r) => r.id === id.toString());
  if (!role) throw new AppError('NOT_FOUND', 'No such role');
  return role;
}

/** A new custom role starts as a copy of another role's permissions and limits. */
export async function createRole(trx: Transaction<DB>, body: CreateRoleRequest): Promise<RoleInfo> {
  const source = await roleById(trx, BigInt(body.copyFromRoleId));
  const slug = body.nameEn
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 22);
  const code = `${slug || 'role'}-${randomBytes(3).toString('hex')}`;
  const role = await trx
    .insertInto('auth.roles')
    .values(
      stamped('auth.roles', {
        code,
        name_ar: body.nameAr,
        name_en: body.nameEn,
        max_discount_bp: source.maxDiscountBp,
        max_discount_fils: BigInt(source.maxDiscountFils),
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  const { permissions: catalog } = await listRoles(trx);
  const copied = source.permissions.filter((p) => !catalog.find((c) => c.code === p)?.ownerOnly);
  if (copied.length > 0) {
    await trx
      .insertInto('auth.role_permissions')
      .values(
        copied.map((permission_code) =>
          stamped('auth.role_permissions', { role_id: role.id, permission_code }),
        ),
      )
      .execute();
  }
  return roleById(trx, role.id);
}

export async function updateRole(
  trx: Transaction<DB>,
  id: bigint,
  body: UpdateRoleRequest,
): Promise<RoleInfo> {
  const role = await roleById(trx, id);
  const changesPermissions =
    body.permissions !== undefined ||
    body.maxDiscountBp !== undefined ||
    body.maxDiscountFils !== undefined;
  if (role.code === 'owner' && (changesPermissions || body.isActive !== undefined)) {
    throw new AppError('OWNER_PROTECTED', 'The owner role always has every permission');
  }
  const changes = {
    ...(body.nameAr !== undefined ? { name_ar: body.nameAr } : {}),
    ...(body.nameEn !== undefined ? { name_en: body.nameEn } : {}),
    ...(body.maxDiscountBp !== undefined ? { max_discount_bp: body.maxDiscountBp } : {}),
    ...(body.maxDiscountFils !== undefined
      ? { max_discount_fils: BigInt(body.maxDiscountFils) }
      : {}),
    ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
  };
  if (Object.keys(changes).length > 0) {
    await trx.updateTable('auth.roles').set(changes).where('id', '=', id).execute();
  }

  if (body.permissions !== undefined) {
    const wanted = new Set(body.permissions);
    const { permissions: catalog } = await listRoles(trx);
    const unknown = [...wanted].filter((p) => !catalog.some((c) => c.code === p));
    if (unknown.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'Unknown permissions', {
        part: 'body',
        issues: unknown.map(() => ({ path: ['permissions'], code: 'unknown_permission' })),
      });
    }
    const current = new Set(role.permissions);
    const removed = [...current].filter((p) => !wanted.has(p));
    const added = [...wanted].filter((p) => !current.has(p));
    if (removed.length > 0) {
      await trx
        .deleteFrom('auth.role_permissions')
        .where('role_id', '=', id)
        .where('permission_code', 'in', removed)
        .execute();
    }
    if (added.length > 0) {
      await trx
        .insertInto('auth.role_permissions')
        .values(
          added.map((permission_code) =>
            stamped('auth.role_permissions', { role_id: id, permission_code }),
          ),
        )
        .execute();
    }
  }
  return roleById(trx, id);
}
