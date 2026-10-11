import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  IdText,
  IMPORT_ENTITIES,
  IMPORT_MAX_BYTES,
  ImportCommitRequest,
  ImportFileRequest,
} from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import { requireAlso } from '../../platform/permissions';
import * as imports from './service';

const importAccess = { kind: 'permission', permission: 'data.import' } as const;
const Entity = z.object({ entity: z.enum(IMPORT_ENTITIES) });
/** Base64 makes the file a third larger; plus room for the JSON around it. */
const BODY_LIMIT = Math.ceil((IMPORT_MAX_BYTES * 4) / 3) + 64 * 1024;

export function registerImportRoutes(app: FastifyInstance): void {
  const db = app.deps.db;

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/imports/:entity/template',
    access: importAccess,
    params: Entity,
    handler: ({ params }) => imports.template(db, params.entity),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/imports/:entity/check',
    access: importAccess,
    params: Entity,
    body: ImportFileRequest,
    bodyLimit: BODY_LIMIT,
    handler: async ({ trx, request, params, body }) => {
      for (const permission of imports.IMPORT_PERMISSIONS[params.entity]) {
        requireAlso(request.auth, permission);
      }
      return {
        body: await imports.checkImport(
          trx,
          params.entity,
          body,
          request.auth?.permissions.has('items.cost') ?? false,
        ),
      };
    },
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/imports/:entity/:batchId/commit',
    access: importAccess,
    params: Entity.extend({ batchId: IdText }),
    body: ImportCommitRequest,
    bodyLimit: BODY_LIMIT,
    reason: ({ params }) => `Excel import ${params.batchId}`,
    handler: async ({ trx, request, params, body }) => {
      for (const permission of imports.IMPORT_PERMISSIONS[params.entity]) {
        requireAlso(request.auth, permission);
      }
      return {
        body: await imports.commitImport(
          trx,
          request.auth!.userId,
          params.entity,
          BigInt(params.batchId),
          body,
          request.auth?.permissions.has('items.cost') ?? false,
          request.auth,
        ),
      };
    },
  });
}
