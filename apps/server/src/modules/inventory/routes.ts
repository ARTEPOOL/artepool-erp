/**
 * Stock routes (M3). Each route names the permission it needs; adjustments also check the
 * permission of their kind (decisions 0015, 0042), and values follow stock.view_cost (0040).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AdjustmentsQuery,
  CreateAdjustmentRequest,
  CreateCountRequest,
  IdText,
  ItemStockQuery,
  PostCountRequest,
  ReactivateRequest,
  ReviewOversellRequest,
  SaveCountLinesRequest,
} from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as counts from './counts';
import * as stock from './service';

const Params = z.object({ id: IdText });
const view = { kind: 'permission', permission: 'stock.view' } as const;
const viewItems = { kind: 'permission', permission: 'items.view' } as const;
const count = { kind: 'permission', permission: 'stock.count' } as const;
const PageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export function registerInventoryRoutes(app: FastifyInstance): void {
  const db = app.deps.db;

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/stock/summary',
    access: viewItems,
    handler: ({ request }) => stock.stockSummary(db, request.auth),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/items/:id/stock',
    access: view,
    params: Params,
    query: ItemStockQuery,
    handler: ({ request, params, query }) =>
      stock.itemStock(db, request.auth, BigInt(params.id), query.page, query.pageSize),
  });

  // Adjustments (ADJ-)
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/stock/adjustments',
    access: view,
    query: AdjustmentsQuery,
    handler: ({ request, query }) => stock.listAdjustments(db, request.auth, query),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/stock/adjustments/:id',
    access: view,
    params: Params,
    handler: ({ request, params }) => stock.getAdjustment(db, request.auth, BigInt(params.id)),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/stock/adjustments',
    access: view,
    body: CreateAdjustmentRequest,
    handler: async ({ trx, request, body }) => ({
      status: 201,
      body: await stock.createAdjustment(trx, request.auth, body),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/stock/adjustments/:id/review',
    access: { kind: 'permission', permission: 'stock.oversell_review' },
    params: Params,
    body: ReviewOversellRequest,
    handler: async ({ trx, request, params, body }) => ({
      body: await stock.reviewOversell(trx, request.auth, BigInt(params.id), body),
    }),
  });

  // Counts (CNT-)
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/stock/counts',
    access: count,
    query: PageQuery,
    handler: ({ request, query }) =>
      counts.listCounts(db, request.auth, query.page, query.pageSize),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/stock/counts/:id',
    access: count,
    params: Params,
    handler: ({ request, params }) => counts.getCount(db, request.auth, BigInt(params.id)),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/stock/counts',
    access: count,
    body: CreateCountRequest,
    handler: async ({ trx, request, body }) => ({
      status: 201,
      body: await counts.getCount(trx, request.auth, await counts.createCount(trx, body)),
    }),
  });
  defineWrite(app, {
    method: 'PUT',
    url: '/api/v1/stock/counts/:id/lines',
    access: count,
    params: Params,
    body: SaveCountLinesRequest,
    handler: async ({ trx, request, params, body }) => {
      await counts.saveCountLines(trx, BigInt(params.id), body);
      return { body: await counts.getCount(trx, request.auth, BigInt(params.id)) };
    },
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/stock/counts/:id/post',
    access: { kind: 'permission', permission: 'stock.count_post' },
    params: Params,
    body: PostCountRequest,
    handler: async ({ trx, request, params, body }) => ({
      body: await counts.postCount(trx, request.auth, BigInt(params.id), body),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/stock/counts/:id/cancel',
    access: { kind: 'permission', permission: 'stock.count_post' },
    params: Params,
    body: ReactivateRequest,
    handler: async ({ trx, request, params, body }) => {
      await counts.cancelCount(trx, BigInt(params.id), body.rowVersion);
      return { body: await counts.getCount(trx, request.auth, BigInt(params.id)) };
    },
  });
}
