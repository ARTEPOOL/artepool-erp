/** The backup service's own records, written in one transaction each as the SYSTEM user. */
import pg from 'pg';
import type { PgConnection } from '@artepool/node-kit';

export const SYSTEM_USER_ID = 1;

export async function connect(connection: PgConnection): Promise<pg.Client> {
  const client = new pg.Client({ ...connection, application_name: 'artepool-backup' });
  await client.connect();
  return client;
}

/** Runs `work` in one transaction with the SYSTEM user and `reason` as the audit context. */
export async function inSystemTx<T>(
  client: pg.Client,
  reason: string,
  work: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT sys.set_context($1, p_reason => $2)', [SYSTEM_USER_ID, reason]);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
