import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { PgConnection } from '@artepool/node-kit';
import type { DB } from './schema.generated';

const INT8 = 20;
const DATE = 1082;

/**
 * BIGINT columns (money in fils, ids) are read as exact `bigint`; DATE columns stay 'YYYY-MM-DD'
 * text so no time zone can shift a business date. NUMERIC (quantities) stays exact text.
 */
type Parser = (value: string) => unknown;
const defaultParser: (oid: number, format?: 'text' | 'binary') => Parser = pg.types.getTypeParser;

const types: pg.CustomTypesConfig = {
  getTypeParser: (oid: number, format?: 'text' | 'binary'): Parser => {
    if (oid === INT8) return (value) => BigInt(value);
    if (oid === DATE) return (value) => value;
    return defaultParser(oid, format);
  },
};

/** Every API connection has strict time limits, so nothing can hang a terminal (§2). */
const SESSION_OPTIONS = [
  '-c statement_timeout=15000',
  '-c lock_timeout=5000',
  '-c idle_in_transaction_session_timeout=30000',
  '-c TimeZone=UTC',
].join(' ');

export function createPool(connection: PgConnection, max = 20): pg.Pool {
  const pool = new pg.Pool({
    ...connection,
    application_name: 'artepool-api',
    options: SESSION_OPTIONS,
    max,
    types,
  });
  // An idle connection closed by the database (PostgreSQL restarted, the restore's swap): the pool
  // drops it and opens a new one when needed. Without a listener the process would stop.
  pool.on('error', () => undefined);
  return pool;
}

export function createDb(pool: pg.Pool): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

export type Db = Kysely<DB>;
