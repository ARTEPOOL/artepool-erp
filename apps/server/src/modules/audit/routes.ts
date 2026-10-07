import type { FastifyInstance } from 'fastify';
import { AuditQuery } from '@artepool/shared/contracts';
import { defineRoute } from '../../platform/http/route';
import * as audit from './service';

export function registerAuditRoutes(app: FastifyInstance): void {
  const deps = app.deps;
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/audit',
    access: { kind: 'permission', permission: 'audit.view' },
    query: AuditQuery,
    handler: ({ query }) => audit.listAudit(deps.db, query),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/audit/chain',
    access: { kind: 'permission', permission: 'audit.view' },
    handler: () => audit.chainStatus(deps.db),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/audit/verify',
    access: { kind: 'permission', permission: 'audit.verify' },
    handler: ({ request }) => audit.verifyNow(deps, request),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/audit/export',
    access: { kind: 'permission', permission: 'audit.export' },
    query: AuditQuery,
    handler: async ({ request, query, reply }) => {
      const csv = await audit.exportAudit(deps, request, query);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="audit-log.csv"')
        .send(csv);
    },
  });
}
