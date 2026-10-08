import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IdText, UpdateSeriesRequest, UpdateVatRateRequest } from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as settings from './service';

const Params = z.object({ id: IdText });
/** Owner only: both permissions are owner-only (decisions 0011, 0033). */
const vatRates = { kind: 'permission', permission: 'system.settings.edit' } as const;
const series = { kind: 'permission', permission: 'system.series.manage' } as const;

export function registerSettingsRoutes(app: FastifyInstance): void {
  const db = app.deps.db;

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/settings/vat',
    access: { kind: 'session' },
    handler: () => settings.listVat(db),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/settings/vat/:id',
    access: vatRates,
    params: Params,
    body: UpdateVatRateRequest,
    reason: ({ body }) => body.reason,
    handler: async ({ trx, params, body }) => ({
      body: await settings.updateVatRate(trx, BigInt(params.id), body),
    }),
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/settings/series',
    access: series,
    handler: async () => ({ series: await settings.listSeries(db) }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/settings/series/:id',
    access: series,
    params: Params,
    body: UpdateSeriesRequest,
    handler: async ({ trx, params, body }) => ({
      body: await settings.updateSeries(trx, BigInt(params.id), body),
    }),
  });
}
