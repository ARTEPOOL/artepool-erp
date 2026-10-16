import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DeactivateRequest,
  IdText,
  ReactivateRequest,
  SaveBankAccountRequest,
  SaveCompanyRequest,
  SaveLogoRequest,
  type BankAccountsResponse,
  type CompanyResponse,
} from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as banks from './bank-accounts';
import * as company from './service';

const Params = z.object({ id: IdText });

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

  // Bank accounts (decision 0065): read by everyone signed in (they print on invoices).
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/company/bank-accounts',
    access: { kind: 'session' },
    handler: async ({ request }): Promise<BankAccountsResponse> => ({
      accounts: await banks.listBankAccounts(db),
      canEdit: await company.canEditCompany(db, request.auth!.userId),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/company/bank-accounts',
    access: edit,
    body: SaveBankAccountRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await banks.createBankAccount(trx, body),
    }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/company/bank-accounts/:id',
    access: edit,
    params: Params,
    body: SaveBankAccountRequest,
    handler: async ({ trx, params, body }) => ({
      body: await banks.updateBankAccount(trx, BigInt(params.id), body),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/company/bank-accounts/:id/deactivate',
    access: edit,
    params: Params,
    body: DeactivateRequest,
    reason: ({ body }) => body.reason,
    handler: async ({ trx, params, body }) => ({
      body: await banks.setBankAccountActive(trx, BigInt(params.id), false, body.rowVersion),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/company/bank-accounts/:id/reactivate',
    access: edit,
    params: Params,
    body: ReactivateRequest,
    handler: async ({ trx, params, body }) => ({
      body: await banks.setBankAccountActive(trx, BigInt(params.id), true, body.rowVersion),
    }),
  });
}
