/**
 * The API's connection pool survives the database closing its idle connections (PostgreSQL
 * restarted, the restore from a backup swapping the database): the next query opens a new one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionFor } from '@artepool/node-kit';
import { createTestDatabase, type TestDatabase } from '@artepool/testing';
import { createPool } from '../../src/platform/db/pool';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(() => db.drop());

describe('the connection pool', () => {
  it('keeps working after the database closes its idle connections', async () => {
    const pool = createPool(connectionFor('api', db.name), 2);
    try {
      await pool.query('SELECT 1');
      expect(pool.idleCount).toBe(1);
      const admin = await db.connect('superuser');
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND application_name = 'artepool-api'`,
        [db.name],
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pool.idleCount).toBe(0);
      const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
      expect(rows).toEqual([{ ok: 1 }]);
    } finally {
      await pool.end();
    }
  });
});
