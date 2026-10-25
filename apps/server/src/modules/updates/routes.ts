import type { FastifyInstance } from 'fastify';
import { UpdateWindowBody } from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as updates from './service';

/** System health → updates (decision 0108): owner only, enforced by owner-only permissions. */
export function registerUpdateRoutes(app: FastifyInstance): void {
  const deps = app.deps;
  const view = { kind: 'permission', permission: 'system.health.view' } as const;
  const manage = { kind: 'permission', permission: 'system.update.manage' } as const;

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/system/update',
    access: view,
    handler: () => updates.updateStatus(deps.db),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/system/update/install-now',
    access: manage,
    reason: () => 'install the downloaded update now',
    handler: async ({ trx }) => ({ status: 201, body: await updates.installNow(trx) }),
  });
  defineWrite(app, {
    method: 'PUT',
    url: '/api/v1/system/update/window',
    access: manage,
    body: UpdateWindowBody,
    reason: ({ body }) => `update night window ${body.startHour}:00–${body.endHour}:00`,
    handler: async ({ trx, body }) => {
      await updates.setWindow(trx, body);
      return { body: { ok: true } };
    },
  });
}
