import { sql, type Kysely, type UpdateResult } from 'kysely';
import { AppError } from '../errors/app-error';
import type { DB } from './schema.generated';

/** Tables whose rows carry `id` and `row_version` (optimistic locking). */
export type VersionedTable = {
  [T in keyof DB]: DB[T] extends { id: unknown; row_version: unknown } ? T : never;
}[keyof DB];

/**
 * "Changed by someone else": an edit updates the row only `WHERE row_version = <the version the
 * screen started from>`. When nothing was updated, this says why: the record is gone (NOT_FOUND)
 * or someone else saved first (STALE_VERSION), and the screen offers to reload.
 */
export async function expectUpdated(
  db: Kysely<DB>,
  table: VersionedTable,
  id: bigint,
  result: UpdateResult | readonly UpdateResult[],
): Promise<void> {
  const results: readonly UpdateResult[] = result instanceof Array ? result : [result];
  const updated = results.reduce((n, r) => n + r.numUpdatedRows, 0n);
  if (updated > 0n) return;
  const { rows } = await sql<{ row_version: number }>`
    SELECT row_version FROM ${sql.table(table)} WHERE id = ${id}`.execute(db);
  if (rows.length === 0) throw new AppError('NOT_FOUND', `No such record in ${table}`);
  throw new AppError('STALE_VERSION', `${table} ${id} was changed by someone else`, {
    currentVersion: rows[0]!.row_version,
  });
}

/** Reads one row's current version, or NOT_FOUND. */
export async function currentVersion(
  db: Kysely<DB>,
  table: VersionedTable,
  id: bigint,
): Promise<number> {
  const { rows } = await sql<{ row_version: number }>`
    SELECT row_version FROM ${sql.table(table)} WHERE id = ${id}`.execute(db);
  if (rows.length === 0) throw new AppError('NOT_FOUND', `No such record in ${table}`);
  return rows[0]!.row_version;
}

/** Refuses the edit unless the row still has the version the screen started from. */
export async function assertVersion(
  db: Kysely<DB>,
  table: VersionedTable,
  id: bigint,
  rowVersion: number,
): Promise<void> {
  const current = await currentVersion(db, table, id);
  if (current !== rowVersion) {
    throw new AppError('STALE_VERSION', `${table} ${id} was changed by someone else`, {
      currentVersion: current,
    });
  }
}

/** Builds a field-level validation error the screens show under the field. */
export function fieldError(field: string, code: string, message = `Invalid ${field}`): AppError {
  return new AppError('VALIDATION_FAILED', message, {
    part: 'body',
    issues: [{ path: [field], code }],
  });
}
