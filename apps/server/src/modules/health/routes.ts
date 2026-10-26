import type { FastifyInstance } from 'fastify';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as health from './service';

/** System health → the server PC (M6.2 part H): owner only, enforced by owner-only permissions. */
export function registerHealthRoutes(app: FastifyInstance): void {
  const deps = app.deps;
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/system/server-health',
    access: { kind: 'permission', permission: 'system.health.view' },
    handler: () => health.serverHealth(deps),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/system/server-health/ups',
    access: { kind: 'permission', permission: 'system.health.manage' },
    reason: () => 'the owner confirms a UPS is connected to the server PC',
    handler: async ({ trx }) => ({ body: await health.confirmUps(trx) }),
  });
}
