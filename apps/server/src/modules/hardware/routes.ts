import type { FastifyInstance } from 'fastify';
import { HardwareCheckRequest } from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import { renderPdf } from '../printing/render';
import * as hardware from './service';

/**
 * System health → the hardware check (M7 part D, decision 0119): the owner, on the PC being
 * checked. Seen with system.health.view, recorded with system.health.manage (both owner only).
 */
export function registerHardwareRoutes(app: FastifyInstance): void {
  const deps = app.deps;
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/system/hardware-checks',
    access: { kind: 'permission', permission: 'system.health.view' },
    handler: ({ request }) => hardware.hardwareChecks(deps.db, request.device!),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/system/hardware-checks',
    access: { kind: 'permission', permission: 'system.health.manage' },
    body: HardwareCheckRequest,
    reason: ({ request }) => `hardware check of ${request.device!.code}`,
    handler: async ({ trx, request, body }) => ({
      status: 201,
      body: await hardware.recordHardwareCheck(trx, request.device!, body),
    }),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/system/hardware-checks/a4-test-page',
    access: { kind: 'permission', permission: 'system.health.manage' },
    handler: async ({ request }) => ({
      fileName: 'a4-test-page.pdf',
      mime: 'application/pdf',
      dataBase64: (
        await renderPdf(await hardware.a4TestPageHtml(deps.db, request.device!.code))
      ).toString('base64'),
    }),
  });
}
