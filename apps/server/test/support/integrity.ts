/**
 * The integrity checks (decisions 0086, 0119) run on a test server's database, as the backup
 * service runs them every night: with the backup role, so its privileges are proven too.
 */
import pg from 'pg';
import { runChecks, type CheckResults } from '@artepool/backup';
import { connectionFor } from '@artepool/node-kit';
import type { TestServer } from './server';

async function databaseOf(server: TestServer): Promise<string> {
  const { rows } = await server.admin.query<{ db: string }>('SELECT current_database() AS db');
  return rows[0]!.db;
}

/** Every check, with the backup role, on the server's database. */
export async function integrityChecks(server: TestServer): Promise<CheckResults> {
  const client = new pg.Client({ ...connectionFor('backup'), database: await databaseOf(server) });
  await client.connect();
  try {
    return await runChecks(client);
  } finally {
    await client.end();
  }
}

/** Only the checks that found something: `{}` when every check passes. */
export const failing = (results: CheckResults): CheckResults =>
  Object.fromEntries(Object.entries(results).filter(([, r]) => !r.ok));

/**
 * Breaks the data behind the database's back (triggers off, as an attacker with full access
 * would), runs every check inside that transaction, then rolls it all back.
 */
export async function checksAfter(server: TestServer, statements: string[]): Promise<CheckResults> {
  await server.admin.query('BEGIN');
  try {
    await server.admin.query('SET LOCAL session_replication_role = replica');
    for (const statement of statements) await server.admin.query(statement);
    return await runChecks(server.admin);
  } finally {
    await server.admin.query('ROLLBACK');
  }
}
