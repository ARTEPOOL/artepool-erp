import type { Db } from '../db/pool';

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
