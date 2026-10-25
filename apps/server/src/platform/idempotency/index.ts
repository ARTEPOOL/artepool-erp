import { sql, type Transaction } from 'kysely';
import { sha256 } from '../crypto/tokens';
import type { DB } from '../db/schema.generated';
import { AppError } from '../errors/app-error';

export interface IdempotencyScope {
  key: string;
  userId: bigint;
  deviceId: bigint;
  endpoint: string;
  requestHash: Buffer;
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

/** JSON with object keys sorted, so the same request always hashes the same. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return v;
  });
}

export function requestHash(method: string, url: string, body: unknown): Buffer {
  return sha256(stableStringify({ method, url, body: body ?? null }));
}

/**
 * The answer already stored for this key, or undefined. A different request → 409.
 *
 * The same request arriving twice at once: the second waits here, on a lock for its key held
 * until the first transaction ends, then reads the first one's stored answer (each statement
 * sees what is committed). Without it, the second could run the work too and hit the business
 * table's own unique rule before the key's, answering "duplicate" instead of the first answer.
 */
export async function findStored(
  trx: Transaction<DB>,
  scope: IdempotencyScope,
): Promise<StoredResponse | undefined> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`idempotency:${scope.key}`}, 0))`.execute(
    trx,
  );
  const row = await trx
    .selectFrom('sys.idempotency_keys')
    .selectAll()
    .where('key', '=', scope.key)
    .executeTakeFirst();
  if (!row) return undefined;
  if (
    row.user_id !== scope.userId ||
    row.device_id !== scope.deviceId ||
    row.endpoint !== scope.endpoint ||
    !row.request_sha256.equals(scope.requestHash)
  ) {
    throw new AppError('IDEMPOTENCY_MISMATCH', 'Idempotency key reused for a different request');
  }
  return { status: row.response_status, body: row.response_body };
}

/** Stores the answer in the same transaction as the work it describes. */
export async function store(
  trx: Transaction<DB>,
  scope: IdempotencyScope,
  response: StoredResponse,
): Promise<void> {
  await trx
    .insertInto('sys.idempotency_keys')
    .values({
      key: scope.key,
      user_id: scope.userId,
      device_id: scope.deviceId,
      endpoint: scope.endpoint,
      request_sha256: scope.requestHash,
      response_status: response.status,
      response_body: JSON.stringify(response.body ?? null, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    })
    .execute();
}
