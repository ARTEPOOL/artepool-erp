import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EnrollCompleteRequest,
  EnrollHelloRequest,
  IdText,
  RenewKeyRequest,
  RevokeDeviceRequest,
  UpdateDeviceRequest,
} from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as devices from './service';

const DeviceParams = z.object({ id: IdText });
const manage = { kind: 'permission', permission: 'system.devices.manage' } as const;

export function registerDeviceRoutes(app: FastifyInstance): void {
  const deps = app.deps;

  // Enrollment: the PC is not enrolled yet, so these two are public (decision 0024).
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/enroll/hello',
    access: { kind: 'public' },
    body: EnrollHelloRequest,
    handler: ({ request, body }) => devices.hello(deps, request, body),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/enroll/complete',
    access: { kind: 'public' },
    body: EnrollCompleteRequest,
    handler: async ({ request, body, reply }) =>
      reply.code(201).send(await devices.complete(deps, request, body)),
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/devices/me',
    access: { kind: 'device' },
    handler: ({ request }) => devices.thisDevice(deps, request),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/devices/me/renew-key',
    access: { kind: 'device' },
    body: RenewKeyRequest,
    handler: ({ request, body }) => devices.renewKey(deps, request, body.newKeyHash),
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/devices',
    access: manage,
    handler: ({ request }) => devices.listDevices(deps, request),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/devices/enrollment-codes',
    access: manage,
    reason: () => 'new device enrollment code',
    handler: async ({ trx }) => ({
      status: 201,
      ...(await devices.newCodeFromSettings(deps, trx)),
    }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/devices/:id',
    access: manage,
    params: DeviceParams,
    body: UpdateDeviceRequest,
    handler: async ({ trx, params, body }) => {
      await devices.updateDevice(trx, BigInt(params.id), body);
      return { body: { ok: true } };
    },
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/devices/:id/revoke',
    access: manage,
    params: DeviceParams,
    body: RevokeDeviceRequest,
    reason: ({ body }) => body.reason,
    handler: async ({ trx, request, params, body }) => {
      await devices.revokeDevice(trx, request, BigInt(params.id), body.reason);
      return { body: { ok: true } };
    },
  });
}
