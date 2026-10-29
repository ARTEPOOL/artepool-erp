/**
 * A sale cut off half way (M6.2 part I), on a real PostgreSQL through the API: the database
 * connection of an "issue" is killed while that sale is waiting for its number, inside its one
 * transaction (golden rule 4). Nothing of it may remain: the invoice is still a draft, no number
 * was used (rule 5: no gap), no stock, payment or journal moved, and the integrity checks pass. The
 * cashier's retry with the same operation key then makes exactly one sale, with the next number.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allOk, runChecks } from '@artepool/backup';
import { connectionFor } from '@artepool/node-kit';
import type { DocumentDetail } from '@artepool/shared/contracts';
import { ok, salesWorld, type SalesWorld } from '../support/sales';
import { startTestServer, type TestServer } from '../support/server';

let server: TestServer;
let world: SalesWorld;

beforeAll(async () => {
  server = await startTestServer();
  world = await salesWorld(server);
}, 120_000);
afterAll(() => server.close());

/** A second superuser connection to the test database (the one that holds the lock). */
async function connect(): Promise<pg.Client> {
  const database = (await server.admin.query<{ db: string }>('SELECT current_database() AS db'))
    .rows[0]!.db;
  const client = new pg.Client({ ...connectionFor('superuser'), database });
  await client.connect();
  return client;
}

const counts = async (documentId: string) =>
  (
    await server.admin.query<{ moves: number; pays: number; entries: number }>(
      `SELECT (SELECT count(*)::int FROM inv.movements m
                 JOIN sales.document_lines l ON l.id = m.sales_document_line_id
                WHERE l.document_id = $1) AS moves,
              (SELECT count(*)::int FROM sales.payment_allocations WHERE document_id = $1) AS pays,
              (SELECT count(*)::int FROM gl.journal_entries WHERE sales_document_id = $1) AS entries`,
      [documentId],
    )
  ).rows[0]!;

const nextInvoiceNumber = async () =>
  (
    await server.admin.query<{ n: string }>(
      `SELECT next_number::text AS n FROM sys.document_series WHERE code = 'INV'`,
    )
  ).rows[0]!.n;

describe('a sale cut off half way', () => {
  it('leaves nothing behind, and the retry makes one sale with the next number', async () => {
    const cust = await world.customer('Power Cut Villa');
    const pump = await world.stockItem('PWR-PUMP', '1000000', '5000', '600000');
    const first = await ok<DocumentDetail>(
      world.issue(await world.draft(cust, pump, '1000'), '10500'),
    );
    const before = await nextInvoiceNumber();

    // Hold the invoice numbering, so the next issue waits inside its transaction...
    const second = await world.draft(cust, pump, '1000');
    const locker = await connect();
    await locker.query('BEGIN');
    // As another issue taking a number would (new documents may still point at the series).
    await locker.query(`SELECT 1 FROM sys.document_series WHERE code = 'INV' FOR NO KEY UPDATE`);
    const key = randomUUID();
    const cut = world.issue(second, '10500', key);
    // ...find that waiting connection, and kill it, as a power cut or a crash would.
    let victim: number | undefined;
    for (let i = 0; i < 100 && victim === undefined; i++) {
      const { rows } = await locker.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE application_name = 'artepool-api' AND pg_backend_pid() = ANY (pg_blocking_pids(pid))`,
      );
      victim = rows[0]?.pid;
      if (victim === undefined) await sleep(50);
    }
    expect(victim).toBeDefined();
    await locker.query('SELECT pg_terminate_backend($1)', [victim]);
    await locker.query('ROLLBACK');
    await locker.end();
    expect((await cut).statusCode).toBeGreaterThanOrEqual(500);

    // Nothing of the cut sale is left.
    const after = await ok<DocumentDetail>(
      world.owner('GET', `/api/v1/sales/documents/${second.id}`),
    );
    expect(after).toMatchObject({ status: 'draft', docNumber: null });
    expect(await counts(second.id)).toEqual({ moves: 0, pays: 0, entries: 0 });
    expect(await nextInvoiceNumber()).toBe(before);
    const checker = await connect();
    try {
      const results = await runChecks(checker);
      expect(results).toMatchObject({
        numbering_gaps: { ok: true },
        stock_vs_ledger: { ok: true },
      });
      expect(allOk(results)).toBe(true);
    } finally {
      await checker.end();
    }

    // The cashier presses "issue" again with the same operation key: one sale, the next number.
    const retried = await ok<DocumentDetail>(world.issue(second, '10500', key));
    const number = (doc: DocumentDetail) => Number(doc.docNumber!.replace(/\D/g, ''));
    expect(number(retried)).toBe(number(first) + 1);
    const again = await world.issue(second, '10500', key);
    expect(again.json<DocumentDetail>().docNumber).toBe(retried.docNumber);
    expect(await counts(second.id)).toEqual({ moves: 1, pays: 1, entries: 1 });
  });
});
