import type { FastifyInstance, FastifyRequest } from 'fastify';
import { UpdateWindowBody } from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import { serverVersion } from '../../platform/version';
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
  // Decision 0115: after an update, every enrolled PC compares this with the version the status
  // page announced, to say whether it worked. Enrolled PCs only; nothing else is in it.
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/system/version',
    access: { kind: 'device' },
    handler: () => Promise.resolve({ version: serverVersion() }),
  });
  // Decision 0115: the updater is woken right after the commit, not on its next run.
  const wake = (request: FastifyRequest) =>
    deps.updates.wake((message) => request.log.warn(message));
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/system/update/check',
    access: manage,
    reason: () => 'check for updates now',
    // Read before the transaction (0115): a slow internet never holds it open.
    prepare: () => updates.readUpdateList(deps.updates.fetchLatest),
    handler: async ({ trx, prepared }) => ({
      status: 201,
      body: await updates.checkNow(trx, prepared),
    }),
    afterCommit: wake,
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/system/update/install-now',
    access: manage,
    reason: () => 'install the downloaded update now',
    handler: async ({ trx }) => ({ status: 201, body: await updates.installNow(trx) }),
    afterCommit: wake,
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
