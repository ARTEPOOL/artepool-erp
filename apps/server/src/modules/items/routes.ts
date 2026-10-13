import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
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
import { quantityFromDb } from '@artepool/shared';
import { AppError } from '../../platform/errors/app-error';
import { createAdjustment, warehouseOf } from '../inventory/service';
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
    handler: async ({ trx, request, body }) => {
      const item = await items.createItem(trx, request.auth, body);
      if (body.openingStock) {
        // The quantity on hand now: the item's opening stock, in the same transaction.
        const reason = await trx
          .selectFrom('sys.reason_codes')
          .select('id')
          .where('category', '=', 'other')
          .where('code', '=', 'OPENING')
          .executeTakeFirstOrThrow();
        await createAdjustment(
          trx,
          request.auth,
          {
            kind: 'opening',
            reasonCodeId: reason.id.toString(),
            lines: [{ itemId: item.id, ...body.openingStock }],
          },
          null,
          { newItem: true },
        );
      }
      return { status: 201, body: item };
    },
  });
  defineWrite(app, {
    method: 'PUT',
    url: '/api/v1/items/:id',
    access: manage,
    params: Params,
    body: UpdateItemRequest,
    handler: async ({ trx, request, params, body }) => {
      const id = BigInt(params.id);
      const updated = await items.updateItem(trx, request.auth, id, body);
      if (!body.stockOnHand) return { body: updated };
      // The quantity typed in the item window: the difference becomes a stock adjustment.
      const { quantityMilli, expectedMilli, approvalId, note } = body.stockOnHand;
      const warehouseId = await warehouseOf(trx, undefined);
      // Locked until the end of the transaction, so two people cannot correct it at once.
      const { rows } = await sql<{ quantity: string }>`
        SELECT quantity::text FROM inv.lock_balances(${warehouseId}, 'available', ARRAY[${id}]::bigint[])`.execute(
        trx,
      );
      const current = rows[0] ? quantityFromDb(rows[0].quantity) : 0n;
      if (current !== BigInt(expectedMilli)) {
        throw new AppError('STALE_VERSION', 'The stock changed since it was shown', {
          currentMilli: current.toString(),
        });
      }
      const diff = BigInt(quantityMilli) - current;
      if (diff === 0n) return { body: updated };
      const kind = diff > 0n ? 'increase' : 'decrease';
      const reason = await trx
        .selectFrom('sys.reason_codes')
        .select('id')
        .where('category', '=', kind === 'increase' ? 'stock_increase' : 'stock_decrease')
        .where('code', '=', 'CORRECTION')
        .executeTakeFirstOrThrow();
      await createAdjustment(trx, request.auth, {
        kind,
        reasonCodeId: reason.id.toString(),
        note,
        ...(approvalId ? { approvalId } : {}),
        lines: [{ itemId: id.toString(), quantityMilli: (diff > 0n ? diff : -diff).toString() }],
      });
      return { body: await items.getItem(trx, id, items.canSeeCost(request.auth)) };
    },
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
