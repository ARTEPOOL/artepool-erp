import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateCategoryRequest,
  CreateItemRequest,
  CreateUnitRequest,
  IdText,
  ItemsQuery,
  NextItemCodeQuery,
  UpdateCategoryRequest,
  UpdateItemRequest,
  UpdateUnitRequest,
} from '@artepool/shared/contracts';
import { defineActivation, defineRoute, defineWrite } from '../../platform/http/route';
import * as catalog from './catalog';
import * as items from './service';

const Params = z.object({ id: IdText });
const view = { kind: 'permission', permission: 'items.view' } as const;
const manage = { kind: 'permission', permission: 'items.manage' } as const;

export function registerItemRoutes(app: FastifyInstance): void {
  const db = app.deps.db;

  // Items
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/items',
    access: view,
    query: ItemsQuery,
    handler: ({ query, request }) =>
      items.listItems(db, query, request.auth?.permissions.has('stock.view_cost') ?? false),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/items/next-code',
    access: manage,
    query: NextItemCodeQuery,
    handler: async ({ query }) => ({
      code: await items.suggestItemCode(db, BigInt(query.categoryId)),
    }),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/items/:id',
    access: view,
    params: Params,
    handler: ({ params, request }) =>
      items.getItem(db, BigInt(params.id), items.canSeeCost(request.auth)),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/items',
    access: manage,
    body: CreateItemRequest,
    handler: async ({ trx, request, body }) => ({
      status: 201,
      body: await items.createItem(trx, request.auth, body),
    }),
  });
  defineWrite(app, {
    method: 'PUT',
    url: '/api/v1/items/:id',
    access: manage,
    params: Params,
    body: UpdateItemRequest,
    handler: async ({ trx, request, params, body }) => ({
      body: await items.updateItem(trx, request.auth, BigInt(params.id), body),
    }),
  });
  defineActivation(app, { base: '/api/v1/items', access: manage, setActive: items.setItemActive });

  // Units and categories (Settings → Lists)
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/units',
    access: { kind: 'session' },
    handler: async () => ({ units: await catalog.listUnits(db) }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/units',
    access: manage,
    body: CreateUnitRequest,
    handler: async ({ trx, body }) => ({ status: 201, body: await catalog.createUnit(trx, body) }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/units/:id',
    access: manage,
    params: Params,
    body: UpdateUnitRequest,
    handler: async ({ trx, params, body }) => ({
      body: await catalog.updateUnit(trx, BigInt(params.id), body),
    }),
  });
  defineActivation(app, {
    base: '/api/v1/units',
    access: manage,
    setActive: catalog.setUnitActive,
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/item-categories',
    access: { kind: 'session' },
    handler: async () => ({ categories: await catalog.listCategories(db) }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/item-categories',
    access: manage,
    body: CreateCategoryRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await catalog.createCategory(trx, body),
    }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/item-categories/:id',
    access: manage,
    params: Params,
    body: UpdateCategoryRequest,
    handler: async ({ trx, params, body }) => ({
      body: await catalog.updateCategory(trx, BigInt(params.id), body),
    }),
  });
  defineActivation(app, {
    base: '/api/v1/item-categories',
    access: manage,
    setActive: catalog.setCategoryActive,
  });
}
