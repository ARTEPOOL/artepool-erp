import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ACCOUNT_LINK_KEYS,
  CreateAccountRequest,
  CreateBusinessLineRequest,
  DeactivateRequest,
  IdText,
  JournalQuery,
  PeriodStepRequest,
  ReactivateRequest,
  ReopenPeriodRequest,
  UpdateAccountLinkRequest,
  UpdateAccountRequest,
  UpdateBusinessLineRequest,
  TrialBalanceQuery,
} from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as accounts from './accounts';
import * as journal from './journal';
import * as periods from './periods';

const Params = z.object({ id: IdText });
const view = { kind: 'permission', permission: 'ledger.view' } as const;
const manageAccounts = { kind: 'permission', permission: 'accounts.manage' } as const;
const managePeriods = { kind: 'permission', permission: 'periods.manage' } as const;

export function registerLedgerRoutes(app: FastifyInstance): void {
  const db = app.deps.db;

  // Journal viewer and trial balance (read-only)
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/journal',
    access: view,
    query: JournalQuery,
    handler: ({ query }) => journal.listJournal(db, query),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/journal/:id',
    access: view,
    params: Params,
    handler: ({ params }) => journal.getJournalEntry(db, BigInt(params.id)),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/trial-balance',
    access: view,
    query: TrialBalanceQuery,
    handler: ({ query }) => journal.trialBalance(db, query),
  });

  // Chart of accounts and event links
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/accounts',
    access: view,
    handler: () => accounts.listAccounts(db),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/accounts',
    access: manageAccounts,
    body: CreateAccountRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await accounts.createAccount(trx, body),
    }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/accounts/:id',
    access: manageAccounts,
    params: Params,
    body: UpdateAccountRequest,
    handler: async ({ trx, params, body }) => ({
      body: await accounts.updateAccount(trx, BigInt(params.id), body),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/accounts/:id/deactivate',
    access: manageAccounts,
    params: Params,
    body: DeactivateRequest,
    reason: ({ body }) => body.reason,
    handler: async ({ trx, params, body }) => ({
      body: await accounts.setAccountActive(trx, BigInt(params.id), false, body.rowVersion),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/accounts/:id/reactivate',
    access: manageAccounts,
    params: Params,
    body: ReactivateRequest,
    handler: async ({ trx, params, body }) => ({
      body: await accounts.setAccountActive(trx, BigInt(params.id), true, body.rowVersion),
    }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/account-links/:key',
    access: manageAccounts,
    params: z.object({ key: z.enum(ACCOUNT_LINK_KEYS) }),
    body: UpdateAccountLinkRequest,
    handler: async ({ trx, params, body }) => ({
      body: await accounts.updateAccountLink(trx, params.key, body),
    }),
  });

  // Lines of business (their accounts are part of the chart's set-up)
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/business-lines',
    access: { kind: 'session' },
    handler: async () => ({ businessLines: await accounts.listBusinessLines(db) }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/business-lines',
    access: manageAccounts,
    body: CreateBusinessLineRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await accounts.createBusinessLine(trx, body),
    }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/business-lines/:id',
    access: manageAccounts,
    params: Params,
    body: UpdateBusinessLineRequest,
    handler: async ({ trx, params, body }) => ({
      body: await accounts.updateBusinessLine(trx, BigInt(params.id), body),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/business-lines/:id/deactivate',
    access: manageAccounts,
    params: Params,
    body: DeactivateRequest,
    reason: ({ body }) => body.reason,
    handler: async ({ trx, params, body }) => ({
      body: await accounts.setBusinessLineActive(trx, BigInt(params.id), false, body.rowVersion),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/business-lines/:id/reactivate',
    access: manageAccounts,
    params: Params,
    body: ReactivateRequest,
    handler: async ({ trx, params, body }) => ({
      body: await accounts.setBusinessLineActive(trx, BigInt(params.id), true, body.rowVersion),
    }),
  });

  // Periods
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/periods',
    access: view,
    handler: () => periods.listPeriods(db),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/periods/:id/close',
    access: managePeriods,
    params: Params,
    body: PeriodStepRequest,
    handler: async ({ trx, params, body }) => ({
      body: await periods.setPeriodStatus(trx, BigInt(params.id), 'closed', body.rowVersion),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/periods/:id/reopen',
    access: managePeriods,
    params: Params,
    body: ReopenPeriodRequest,
    reason: ({ body }) => body.reason,
    handler: async ({ trx, params, body }) => ({
      body: await periods.setPeriodStatus(trx, BigInt(params.id), 'open', body.rowVersion),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/periods/:id/lock',
    access: managePeriods,
    params: Params,
    body: PeriodStepRequest,
    handler: async ({ trx, params, body }) => ({
      body: await periods.setPeriodStatus(trx, BigInt(params.id), 'locked', body.rowVersion),
    }),
  });
}
