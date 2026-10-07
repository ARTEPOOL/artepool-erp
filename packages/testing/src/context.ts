import type pg from 'pg';

export const SYSTEM_USER_ID = 1n;

/**
 * Sets the request context for the current transaction (call after BEGIN), as the API does
 * for every business operation. Without it, every audited write is refused.
 */
export async function setContext(
  client: pg.Client,
  userId: bigint = SYSTEM_USER_ID,
  reason: string | null = null,
): Promise<void> {
  await client.query(
    'SELECT sys.set_context($1::bigint, NULL, NULL, gen_random_uuid(), NULL, NULL, $2, NULL)',
    [userId.toString(), reason],
  );
}

/** Runs `work` in a transaction with the request context set, and commits. */
export async function inContext<T>(
  client: pg.Client,
  work: () => Promise<T>,
  userId: bigint = SYSTEM_USER_ID,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await setContext(client, userId);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
