import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionFor, migrationsDir } from '@artepool/node-kit';
import { createTestDatabase, type TestDatabase } from '@artepool/testing';
import { buildApp } from '../../src/app';
import { SecretBox } from '../../src/platform/crypto/secret-box';
import { createDeps } from '../../src/platform/http/deps';
import { createDb, createPool, type Db } from '../../src/platform/db/pool';
import { withBusinessTx, type RequestContext } from '../../src/platform/db/tx';

let testDb: TestDatabase;
let db: Db;

const ctx = (reason: string): RequestContext => ({ userId: 1n, requestId: randomUUID(), reason });

async function headSeq(): Promise<bigint> {
  const row = await db.selectFrom('audit.chain_head').select('last_seq').executeTakeFirstOrThrow();
  return row.last_seq;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createDb(createPool(connectionFor('api', testDb.name), 5));
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

describe('withBusinessTx: one business operation = one transaction', () => {
  it('commits the work together with its audit entries, which carry the request context', async () => {
    const context = ctx('new branch for the showroom');
    const id = await withBusinessTx(db, context, async (trx) => {
      const row = await trx
        .insertInto('sys.branches')
        .values({ code: 'SHOW', name_ar: 'المعرض', name_en: 'Showroom' } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    expect(typeof id).toBe('bigint');
    const entry = await db
      .selectFrom('audit.log')
      .select(['user_id', 'request_id', 'reason', 'entity_id', 'row_hash'])
      .where('entity_type', '=', 'sys.branches')
      .where('entity_id', '=', id.toString())
      .executeTakeFirstOrThrow();
    expect(entry).toMatchObject({
      user_id: 1n,
      request_id: context.requestId,
      reason: 'new branch for the showroom',
    });
    expect(entry.row_hash).not.toBeNull();
  });

  it('saves nothing at all when the operation fails part-way', async () => {
    const before = await headSeq();
    await expect(
      withBusinessTx(db, ctx('half-done'), async (trx) => {
        await trx
          .insertInto('sys.branches')
          .values({ code: 'HALF', name_ar: 'نصف', name_en: 'Half' } as never)
          .execute();
        throw new Error('printer exploded');
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    const half = await db
      .selectFrom('sys.branches')
      .select('id')
      .where('code', '=', 'HALF')
      .execute();
    expect(half).toEqual([]);
    expect(await headSeq()).toBe(before);
  });

  it('reports database rule violations as app errors', async () => {
    await expect(
      withBusinessTx(db, ctx('try to delete'), (trx) => trx.deleteFrom('sys.branches').execute()),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED', httpStatus: 403 });
    await expect(
      withBusinessTx(db, ctx('duplicate'), (trx) =>
        trx
          .insertInto('sys.branches')
          .values({ code: 'hq', name_ar: 'م', name_en: 'HQ' } as never)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE', httpStatus: 409 });
  });

  it('retries once, automatically, when two terminals deadlock', async () => {
    const [a, b] = await Promise.all(
      ['DL1', 'DL2'].map((code) =>
        withBusinessTx(db, ctx('setup'), (trx) =>
          trx
            .insertInto('sys.branches')
            .values({ code, name_ar: 'ف', name_en: code } as never)
            .returning('id')
            .executeTakeFirstOrThrow(),
        ),
      ),
    );
    let attempts = 0;
    let arrived = 0;
    let release!: () => void;
    const bothLocked = new Promise<void>((resolve) => (release = resolve));
    const crossUpdate = (first: bigint, second: bigint) =>
      withBusinessTx(db, ctx('cross update'), async (trx) => {
        attempts++;
        await trx
          .updateTable('sys.branches')
          .set({ name_en: 'x' })
          .where('id', '=', first)
          .execute();
        if (++arrived === 2) release();
        await bothLocked;
        await trx
          .updateTable('sys.branches')
          .set({ name_en: 'y' })
          .where('id', '=', second)
          .execute();
      });
    await Promise.all([crossUpdate(a!.id, b!.id), crossUpdate(b!.id, a!.id)]);
    expect(attempts).toBe(3); // two first attempts, one retry after PostgreSQL broke the deadlock
  });

  it('applies the safety time limits to every connection', async () => {
    const { rows } = await sql<{ s: string; l: string }>`
      SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l`.execute(
      db,
    );
    expect(rows[0]).toEqual({ s: '15s', l: '5s' });
  });
});

describe('GET /health', () => {
  it('reports the database, schema version and audit chain head', async () => {
    const app = buildApp(
      { logLevel: 'silent' },
      createDeps({ db, secretBox: SecretBox.fromKey(Buffer.alloc(32, 1)) }),
    );
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      status: string;
      schemaVersion: number;
      auditChain: { lastSeq: string; fingerprint: string };
    }>();
    const latest = Math.max(
      ...readdirSync(migrationsDir)
        .filter((f) => /^\d{4}_.+\.sql$/.test(f))
        .map((f) => Number(f.slice(0, 4))),
    );
    expect(body).toMatchObject({ status: 'ok', database: 'up', schemaVersion: latest });
    expect(body.auditChain.lastSeq).toMatch(/^\d+$/);
    expect(body.auditChain.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    await app.close();
  });
});
