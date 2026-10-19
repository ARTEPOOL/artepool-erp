import type { FastifyInstance } from 'fastify';
import {
  BackupRequestBody,
  ConfirmBackupKeyBody,
  DriveAuthorizeBody,
  DriveCallbackBody,
} from '@artepool/shared/contracts';
import { AppError } from '../../platform/errors/app-error';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as backup from './service';

/** Settings → System health (decision 0086): owner only, enforced by owner-only permissions. */
export function registerBackupRoutes(app: FastifyInstance): void {
  const deps = app.deps;
  const view = { kind: 'permission', permission: 'system.health.view' } as const;
  const manage = { kind: 'permission', permission: 'system.backup.manage' } as const;

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/health/system',
    access: view,
    handler: () => backup.healthStatus(deps),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/backup/requests',
    access: manage,
    body: BackupRequestBody,
    reason: ({ body }) => `backup request: ${body.kind}`,
    handler: async ({ trx, request, body }) => {
      // The restore test has its own permission (owner only as well).
      if (
        body.kind === 'restore_test' &&
        !request.auth!.permissions.has('system.backup.restore_test')
      ) {
        throw new AppError('PERMISSION_DENIED', 'Restore test not allowed', {
          permission: 'system.backup.restore_test',
        });
      }
      return { status: 201, body: await backup.createRequest(trx, body) };
    },
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/backup/key',
    access: manage,
    handler: () => backup.newBackupKey(),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/backup/key/confirm',
    access: manage,
    body: ConfirmBackupKeyBody,
    reason: () => 'new backup key (public part); the private key stays offline with the owner',
    handler: async ({ trx, body }) => ({ body: await backup.confirmBackupKey(deps, trx, body) }),
  });
  const context = (request: {
    auth?: { userId: bigint; sessionId: bigint } | null;
    device?: { id: bigint } | null;
  }) => ({
    userId: request.auth!.userId,
    deviceId: request.device!.id,
    sessionId: request.auth!.sessionId,
  });
  // Choose the account in the browser (decision 0095).
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/backup/drive/authorize',
    access: manage,
    body: DriveAuthorizeBody,
    handler: ({ request, body }) =>
      Promise.resolve(backup.authorizeDrive(deps, request.auth!.userId, body)),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/backup/drive/callback',
    access: manage,
    body: DriveCallbackBody,
    handler: ({ request, body }) => backup.driveCallback(deps, context(request), body),
  });
  // The fallback: a code typed at google.com/device.
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/backup/drive/connect',
    access: manage,
    handler: ({ request }) => backup.startDriveConnect(deps, request.auth!.userId),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/backup/drive/finish',
    access: manage,
    handler: ({ request }) => backup.finishDriveConnect(deps, context(request)),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/backup/drive/disconnect',
    access: manage,
    reason: () => 'Google Drive disconnected',
    handler: async ({ trx }) => ({ body: await backup.disconnectDrive(deps, trx) }),
  });
}
