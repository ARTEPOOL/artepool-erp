/**
 * A power cut during a sale (M6.2 part I), on a PostgreSQL server of its own that this test stops
 * the way a power cut does (no checkpoint, no clean shutdown) while a second sale is half way
 * through its one transaction. After the restart (recovery from the WAL): the first, confirmed
 * sale is all there (number, stock, payment, journal); nothing of the second is (still a draft, no
 * number used); the integrity checks pass; and the second sale then goes through with the next
 * number. The API's connections, cut by the crash, come back by themselves.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allOk, runChecks } from '@artepool/backup';
import { connectionFor } from '@artepool/node-kit';
import type { DocumentDetail } from '@artepool/shared/contracts';
import setupTemplate from '@artepool/testing/global-setup';
import { startCluster, type Cluster } from '../support/cluster';
import { ok, salesWorld, type SalesWorld } from '../support/sales';
import { startTestServer, type TestServer } from '../support/server';

let cluster: Cluster;
let dropTemplate: () => Promise<void>;
let server: TestServer;
let world: SalesWorld;
let database: string;

beforeAll(async () => {
  cluster = await startCluster(process.env.PG_SUPERUSER_PASSWORD ?? '');
  // Everything in this test file talks to that server (each test file runs on its own).
  process.env.PGHOST = '127.0.0.1';
  process.env.PGPORT = String(cluster.port);
  dropTemplate = await setupTemplate();
  server = await startTestServer();
  world = await salesWorld(server);
  database = (await server.admin.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!
    .db;
}, 300_000);

afterAll(async () => {
  await server?.close().catch(() => undefined);
  await dropTemplate?.().catch(() => undefined);
  await cluster?.remove();
});

async function superuser(): Promise<pg.Client> {
  const client = new pg.Client({ ...connectionFor('superuser'), database });
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

describe('a power cut during a sale', () => {
  it('keeps the confirmed sale whole, leaves nothing of the cut one, and the books check out', async () => {
    const cust = await world.customer('Blackout Villa');
    const pump = await world.stockItem('CUT-PUMP', '1000000', '5000', '600000');
    const first = await ok<DocumentDetail>(
      world.issue(await world.draft(cust, pump, '1000'), '10500'),
    );
    const second = await world.draft(cust, pump, '2000');

    // The second sale starts and waits for its number inside its transaction...
    const locker = await superuser();
    await locker.query('BEGIN');
    await locker.query(`SELECT 1 FROM sys.document_series WHERE code = 'INV' FOR NO KEY UPDATE`);
    const key = randomUUID();
    const cut = world.issue(second, '21000', key);
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      const { rows } = await locker.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE application_name = 'artepool-api' AND pg_backend_pid() = ANY (pg_blocking_pids(pid))`,
      );
      waiting = rows.length > 0;
      if (!waiting) await sleep(50);
    }
    expect(waiting).toBe(true);
    // ...and the power goes.
    await cluster.crash();
    await locker.end().catch(() => undefined);
    expect((await cut).statusCode).toBeGreaterThanOrEqual(500);

    await cluster.start();
    expect(await cluster.log()).toMatch(/database system was interrupted|not properly shut down/);
    expect(await cluster.log()).toMatch(/redo done|automatic recovery/);

    const db = await superuser();
    try {
      const doc = async (id: string) =>
        (
          await db.query<{ status: string; doc_number: string | null }>(
            'SELECT status, doc_number FROM sales.documents WHERE id = $1',
            [id],
          )
        ).rows[0]!;
      const parts = async (id: string) =>
        (
          await db.query<{ moves: number; pays: number; entries: number }>(
            `SELECT (SELECT count(*)::int FROM inv.movements m
                       JOIN sales.document_lines l ON l.id = m.sales_document_line_id
                      WHERE l.document_id = $1) AS moves,
                    (SELECT count(*)::int FROM sales.payment_allocations WHERE document_id = $1) AS pays,
                    (SELECT count(*)::int FROM gl.journal_entries WHERE sales_document_id = $1) AS entries`,
            [id],
          )
        ).rows[0]!;
      // The confirmed sale is all there; nothing of the cut one is.
      expect(await doc(first.id)).toEqual({ status: 'issued', doc_number: first.docNumber });
      expect(await parts(first.id)).toEqual({ moves: 1, pays: 1, entries: 1 });
      expect(await doc(second.id)).toEqual({ status: 'draft', doc_number: null });
      expect(await parts(second.id)).toEqual({ moves: 0, pays: 0, entries: 0 });
      const results = await runChecks(db);
      expect(results).toMatchObject({
        audit_chain: { ok: true },
        numbering_gaps: { ok: true },
        stock_vs_ledger: { ok: true },
        trial_balance: { ok: true },
      });
      expect(allOk(results)).toBe(true);
    } finally {
      await db.end();
    }

    // The API's connections were cut by the crash; the next sale goes through with the next number.
    let retried: DocumentDetail | undefined;
    for (let i = 0; i < 10 && !retried; i++) {
      const r = await world.issue(second, '21000', key);
      if (r.statusCode === 200) retried = r.json<DocumentDetail>();
      else await sleep(200);
    }
    const number = (d: DocumentDetail) => Number(d.docNumber!.replace(/\D/g, ''));
    expect(number(retried!)).toBe(number(first) + 1);
  });
});
