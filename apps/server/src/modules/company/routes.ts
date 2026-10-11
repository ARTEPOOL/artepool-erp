import type { FastifyInstance } from 'fastify';
import {
  SaveCompanyRequest,
  SaveLogoRequest,
  type CompanyResponse,
} from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as company from './service';

/** Owner only (decision 0030): `system.company.edit` is an owner-only permission. */
const edit = { kind: 'permission', permission: 'system.company.edit' } as const;

export function registerCompanyRoutes(app: FastifyInstance): void {
  const db = app.deps.db;

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/company',
    access: { kind: 'session' },
    handler: async ({ request }): Promise<CompanyResponse> => ({
      company: await company.getCompany(db),
      canEdit: await company.canEditCompany(db, request.auth!.userId),
    }),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/company/logo',
    access: { kind: 'session' },
    handler: () => company.getLogo(db),
  });
  defineWrite(app, {
    method: 'PUT',
    url: '/api/v1/company',
    access: edit,
    body: SaveCompanyRequest,
    handler: async ({ trx, body }) => ({ body: await company.saveCompany(trx, body) }),
  });
  defineWrite(app, {
    method: 'PUT',
    url: '/api/v1/company/logo',
    access: edit,
    body: SaveLogoRequest,
    handler: async ({ trx, body }) => ({ body: await company.saveLogo(trx, body) }),
  });
}
