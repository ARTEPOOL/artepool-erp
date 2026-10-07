import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../platform/db/pool';

export interface HealthReport {
  status: 'ok' | 'unavailable';
  serverTime: string;
  database: 'up' | 'down';
  schemaVersion: number | null;
  auditChain: { lastSeq: string; fingerprint: string } | null;
}

/** GET /health — is the server running, can it reach the database, where is the audit chain. */
export function registerHealth(app: FastifyInstance, db: Db): void {
  app.get('/health', async (_request, reply) => {
    const report: HealthReport = {
      status: 'ok',
      serverTime: new Date().toISOString(),
      database: 'up',
      schemaVersion: null,
      auditChain: null,
    };
    try {
      const version = await db
        .selectFrom('sys.schema_migrations')
        .select(sql<number>`max(version)`.as('v'))
        .executeTakeFirst();
      const head = await db
        .selectFrom('audit.chain_head')
        .select(['last_seq', sql<string>`left(encode(last_hash, 'hex'), 16)`.as('fingerprint')])
        .executeTakeFirstOrThrow();
      report.schemaVersion = version?.v ?? null;
      report.auditChain = { lastSeq: head.last_seq.toString(), fingerprint: head.fingerprint };
      return report;
    } catch (error) {
      app.log.error({ err: error }, 'health check: database unavailable');
      report.status = 'unavailable';
      report.database = 'down';
      return reply.code(503).send(report);
    }
  });
}
