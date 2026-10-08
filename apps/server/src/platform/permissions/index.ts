import type { Db } from '../db/pool';
import { AppError } from '../errors/app-error';

/** The permission codes a user holds through their active roles (empty if the user is inactive). */
export async function permissionsOf(db: Db, userId: bigint): Promise<Set<string>> {
  const rows = await db
    .selectFrom('auth.user_roles as ur')
    .innerJoin('auth.users as u', 'u.id', 'ur.user_id')
    .innerJoin('auth.roles as r', 'r.id', 'ur.role_id')
    .innerJoin('auth.role_permissions as rp', 'rp.role_id', 'r.id')
    .select('rp.permission_code')
    .distinct()
    .where('ur.user_id', '=', userId)
    .where('u.is_active', '=', true)
    .where('r.is_active', '=', true)
    .execute();
  return new Set(rows.map((r) => r.permission_code));
}

/**
 * A second permission some actions need on top of their route's one (for example a price change
 * inside an item edit needs `prices.manage`). The route guard has already loaded the user's
 * permissions into `request.auth`.
 */
export function requireAlso(
  auth: { permissions: ReadonlySet<string> } | null,
  permission: string,
): void {
  if (!auth?.permissions.has(permission)) {
    throw new AppError('PERMISSION_DENIED', `Missing permission ${permission}`, { permission });
  }
}
