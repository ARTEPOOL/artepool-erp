import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApprovalRequest } from '@artepool/shared/contracts';
import { defineRoute } from '../../platform/http/route';
import * as approvals from './service';

/** Any signed-in user may ask for an approval; the approver's permission is what counts. */
export function registerApprovalRoutes(app: FastifyInstance): void {
  const deps = app.deps;
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/approvals/approvers',
    access: { kind: 'session' },
    query: z.object({ permission: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/) }),
    handler: async ({ request, query }) => ({
      approvers: await approvals.approvers(deps, request, query.permission),
    }),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/approvals',
    access: { kind: 'session' },
    body: ApprovalRequest,
    handler: async ({ request, body, reply }) =>
      reply.code(201).send(await approvals.createApproval(deps, request, body)),
  });
}
