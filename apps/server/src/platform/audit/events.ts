import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.generated';

export interface EventDetails {
  entityType?: string | null;
  entityId?: string | bigint | null;
  /** Never put a secret here: no passwords, PINs, codes, tokens or keys. */
  data?: Record<string, unknown> | null;
  reason?: string | null;
}

/**
 * Writes an explicit event (sign-in, lock, permission refused, …) into the hash-chained audit
 * log, inside the caller's transaction and with its request context.
 */
export async function recordEvent(
  trx: Kysely<DB>,
  event: string,
  details: EventDetails = {},
): Promise<void> {
  const data = details.data
    ? JSON.stringify(details.data, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
    : null;
  await sql`SELECT audit.record_event(${event}, ${details.entityType ?? null},
    ${details.entityId?.toString() ?? null}, ${data}::jsonb, ${details.reason ?? null})`.execute(
    trx,
  );
}
