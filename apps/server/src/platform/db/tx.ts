import { sql, type Transaction } from 'kysely';
import { isRetryable, toAppError } from '../errors/app-error';
import type { Db } from './pool';
import type { DB } from './schema.generated';

/** Who is doing this, from where, and why. Written into every audit entry of the transaction. */
export interface RequestContext {
  userId: bigint;
  requestId: string;
  deviceId?: bigint | null;
  sessionId?: bigint | null;
  clientIp?: string | null;
  clientTime?: Date | null;
  reason?: string | null;
  approvalId?: bigint | null;
}

/**
 * Runs one business operation as ONE database transaction (golden rule 4): everything it writes,
 * including its audit entries, is committed together or not at all.
 *
 * `work` must only touch the database (no printing, no messages): after a deadlock the whole
 * transaction is rolled back and `work` runs once more from the start.
 */
export async function withBusinessTx<T>(
  db: Db,
  context: RequestContext,
  work: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction().execute(async (trx) => {
        await sql`SELECT sys.set_context(
            ${context.userId}::bigint, ${context.deviceId ?? null}::bigint,
            ${context.sessionId ?? null}::bigint, ${context.requestId}::uuid,
            ${context.clientIp ?? null}::inet, ${context.clientTime ?? null}::timestamptz,
            ${context.reason ?? null}::text, ${context.approvalId ?? null}::bigint)`.execute(trx);
        return work(trx);
      });
    } catch (error) {
      if (attempt === 1 && isRetryable(error)) continue;
      throw toAppError(error);
    }
  }
}
