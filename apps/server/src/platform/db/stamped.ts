import type { InsertObject } from 'kysely';
import type { DB } from './schema.generated';

/** Columns that database triggers always fill from the request context (never sent by the API). */
type StampColumn = 'created_by' | 'updated_by' | 'granted_by';

/** A new row as the API writes it (values or SQL expressions); the "who" columns are left out. */
export type NewRow<TB extends keyof DB> = Omit<InsertObject<DB, TB>, StampColumn>;

/** Types a new row for `insertInto(table).values(...)`; the triggers add who and when. */
export function stamped<TB extends keyof DB>(_table: TB, values: NewRow<TB>): InsertObject<DB, TB> {
  return values as InsertObject<DB, TB>;
}

/**
 * Types a new row whose other required columns are always filled by the table's own trigger
 * (document numbers, the accounting period, who posted). The API has no privilege on those
 * columns, so they are never sent.
 */
export function filledByDatabase<TB extends keyof DB>(
  _table: TB,
  values: Partial<NewRow<TB>>,
): InsertObject<DB, TB> {
  return values as InsertObject<DB, TB>;
}
