import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EnrollCompleteRequest,
  EnrollHelloRequest,
  IdText,
  KioskCodeUnlockRequest,
  KioskEventRequest,
  MoveDrawerRequest,
  RenewKeyRequest,
  RevokeDeviceRequest,
  SetKioskLockRequest,
  UpdateDeviceRequest,
} from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as kiosk from './kiosk';
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
    url: '/api/v1/devices/:id/end-trust',
    access: manage,
    params: DeviceParams,
    reason: () => 'end trust: the phone code is needed again on this PC',
    handler: async ({ trx, params }) => ({
      body: { ended: await devices.endDeviceTrust(trx, BigInt(params.id)) },
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/devices/:id/move-drawer',
    access: manage,
    params: DeviceParams,
    body: MoveDrawerRequest,
    reason: ({ body }) => body.reason,
    handler: async ({ trx, params, body }) => {
      await devices.moveDrawer(trx, BigInt(params.id), body);
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

  // The POS kiosk lock (decisions 0082, 0083, 0089).
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/kiosk/state',
    access: { kind: 'device' },
    handler: ({ request }) => kiosk.kioskState(deps, request),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/kiosk/unlock-with-code',
    access: { kind: 'device' },
    body: KioskCodeUnlockRequest,
    handler: ({ request, body }) => kiosk.unlockWithOwnerCode(deps, request, body),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/kiosk/events',
    access: { kind: 'device' },
    body: KioskEventRequest,
    handler: ({ request, body }) => kiosk.kioskEvent(deps, request, body),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/kiosk/alerts',
    access: manage,
    handler: ({ request }) => kiosk.kioskAlerts(deps.db, request.auth!.userId),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/devices/:id/kiosk-lock',
    access: manage,
    params: DeviceParams,
    body: SetKioskLockRequest,
    reason: ({ body }) => body.reason,
    handler: async ({ trx, request, params, body }) => ({
      body: await kiosk.setKioskLock(deps, trx, request, BigInt(params.id), body),
    }),
  });
}
