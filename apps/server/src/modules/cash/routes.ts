/**
 * Shift routes (M5): open, cash movements, No Sale, X report, the blind count and one recount,
 * the close (Z), history, variance acceptance and cash alerts. "current" is always the signed-in
 * user's own open shift on this PC (decision 0004).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AcceptVarianceRequest,
  CashMovementRequest,
  CloseShiftRequest,
  CountLines,
  ForceCloseShiftRequest,
  IdText,
  NoSaleRequest,
  OpenShiftRequest,
  RecountRequest,
  ShiftsQuery,
} from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as shifts from './shifts';

const Params = z.object({ id: IdText });
const allow = (permission: string) => ({ kind: 'permission', permission }) as const;

export function registerCashRoutes(app: FastifyInstance): void {
  const db = app.deps.db;

  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/shifts',
    access: allow('shifts.open'),
    body: OpenShiftRequest,
    handler: async ({ trx, request, body }) => ({
      body: await shifts.openShift(trx, request, body),
      status: 201,
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/shifts/current/movements',
    access: allow('shifts.open'),
    body: CashMovementRequest,
    reason: ({ body }) => body.note ?? null,
    handler: async ({ trx, request, body }) => ({
      body: await shifts.moveCash(trx, request, body),
      status: 201,
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/shifts/current/no-sale',
    access: allow('pos.no_sale'),
    body: NoSaleRequest,
    reason: ({ body }) => body.note ?? null,
    handler: async ({ trx, request, body }) => {
      await shifts.noSale(trx, request, body);
      return { body: { ok: true } };
    },
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/shifts/current/x-report',
    access: allow('reports.x'),
    handler: async ({ request }) => shifts.xReport(db, request),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/shifts/current/count',
    access: allow('shifts.close'),
    body: CountLines,
    handler: async ({ trx, request, body }) => ({
      body: await shifts.countCash(trx, request, body, false),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/shifts/current/recount',
    access: allow('shifts.close'),
    body: RecountRequest,
    handler: async ({ trx, request, body }) => ({
      body: await shifts.countCash(trx, request, body, true),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/shifts/current/close',
    access: allow('shifts.close'),
    body: CloseShiftRequest,
    reason: ({ body }) => body.varianceNote ?? null,
    handler: async ({ trx, request, body }) => ({
      body: await shifts.closeShift(trx, request, body),
    }),
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/shifts',
    access: allow('shifts.open'),
    query: ShiftsQuery,
    handler: async ({ request, query }) => shifts.listShifts(db, request.auth, query),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/shifts/alerts',
    access: allow('shifts.view_all'),
    handler: async () => shifts.cashAlerts(db),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/shifts/:id',
    access: allow('shifts.open'),
    params: Params,
    handler: async ({ request, params }) =>
      shifts.getShiftReport(db, request.auth, BigInt(params.id)),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/shifts/:id/force-close',
    access: allow('shifts.force_close'),
    params: Params,
    body: ForceCloseShiftRequest,
    reason: ({ body }) => body.reason,
    handler: async ({ trx, request, params, body }) => ({
      body: await shifts.forceCloseShift(trx, request, BigInt(params.id), body),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/shifts/:id/accept-variance',
    access: allow('cash.variance_accept'),
    params: Params,
    body: AcceptVarianceRequest,
    reason: ({ body }) => body.note,
    handler: async ({ trx, request, params, body }) => ({
      body: await shifts.acceptVariance(trx, request.auth, BigInt(params.id), body),
    }),
  });
}
