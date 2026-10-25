import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../platform/db/schema.generated';

/** Whether this user holds the owner role (the database's own rule, `auth.is_owner`). */
export async function isOwner(db: Kysely<DB> | Transaction<DB>, userId: bigint): Promise<boolean> {
  const { rows } = await sql<{ owner: boolean }>`SELECT auth.is_owner(${userId}) AS owner`.execute(
    db,
  );
  return rows[0]?.owner === true;
}
