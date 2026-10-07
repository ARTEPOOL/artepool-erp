import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateRoleRequest,
  CreateUserRequest,
  DeactivateUserRequest,
  IdText,
  ResetCredentialsRequest,
  UpdateRoleRequest,
  UpdateUserRequest,
} from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as users from './service';

const Params = z.object({ id: IdText });
const manage = { kind: 'permission', permission: 'users.manage' } as const;
const view = { kind: 'permission', permission: 'users.view' } as const;
const roles = { kind: 'permission', permission: 'roles.manage' } as const;

export function registerUserRoutes(app: FastifyInstance): void {
  const deps = app.deps;
  const base = '/api/v1/users';

  defineRoute(app, {
    method: 'GET',
    url: base,
    access: view,
    handler: async () => ({ users: await users.listUsers(deps.db) }),
  });
  defineWrite(app, {
    method: 'POST',
    url: base,
    access: manage,
    body: CreateUserRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      ...(await users.createUser(trx, deps, body)),
    }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: `${base}/:id`,
    access: manage,
    params: Params,
    body: UpdateUserRequest,
    handler: async ({ trx, params, body }) => ({
      body: await users.updateUser(trx, BigInt(params.id), body),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: `${base}/:id/reset-credentials`,
    access: { kind: 'permission', permission: 'users.reset_credentials' },
    params: Params,
    body: ResetCredentialsRequest,
    reason: () => 'credentials reset by the owner',
    handler: async ({ trx, params, body }) =>
      users.resetCredentials(trx, deps, BigInt(params.id), body.signInMethod),
  });
  defineWrite(app, {
    method: 'POST',
    url: `${base}/:id/unlock`,
    access: manage,
    params: Params,
    reason: () => 'unlocked by the owner',
    handler: async ({ trx, params }) => ({ body: await users.unlockUser(trx, BigInt(params.id)) }),
  });
  defineWrite(app, {
    method: 'POST',
    url: `${base}/:id/deactivate`,
    access: manage,
    params: Params,
    body: DeactivateUserRequest,
    reason: ({ body }) => body.reason,
    handler: async ({ trx, request, params, body }) => ({
      body: await users.deactivateUser(trx, request, BigInt(params.id), body.reason),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: `${base}/:id/reactivate`,
    access: manage,
    params: Params,
    handler: async ({ trx, params }) => ({
      body: await users.reactivateUser(trx, BigInt(params.id)),
    }),
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/roles',
    access: view,
    handler: () => users.listRoles(deps.db),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/roles',
    access: roles,
    body: CreateRoleRequest,
    handler: async ({ trx, body }) => ({ status: 201, body: await users.createRole(trx, body) }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/roles/:id',
    access: roles,
    params: Params,
    body: UpdateRoleRequest,
    handler: async ({ trx, params, body }) => ({
      body: await users.updateRole(trx, BigInt(params.id), body),
    }),
  });
}
