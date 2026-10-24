/**
 * POS routes (M5): the POS state of this PC, sales, held carts and returns. Each sale is one
 * idempotent write: a retry with the same key never sells twice.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  HoldCartRequest,
  IdText,
  PosReturnRequest,
  PosSaleRequest,
} from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import { holdCart, listHeldCarts, posState, settleHeldCart } from './carts';
import { posReturn, sell } from './sales';
import { receiptData, receiptPrinted } from './receipts';

const Params = z.object({ id: IdText });
const sellAccess = { kind: 'permission', permission: 'pos.sell' } as const;

export function registerPosRoutes(app: FastifyInstance): void {
  const db = app.deps.db;

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/pos/state',
    access: sellAccess,
    handler: async ({ request }) => posState(db, request),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/pos/sales',
    access: sellAccess,
    body: PosSaleRequest,
    handler: async ({ trx, request, body }) => ({
      body: await sell(trx, request, body),
      status: 201,
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/pos/returns',
    access: sellAccess,
    body: PosReturnRequest,
    reason: ({ body }) => body.reasonText,
    handler: async ({ trx, request, body }) => ({
      body: await posReturn(trx, request, body),
      status: 201,
    }),
  });

  // The receipt of an issued document, and the count of its prints (the first is the original).
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/pos/receipts/:id',
    access: { kind: 'permission', permission: 'invoices.view' },
    params: Params,
    handler: async ({ params }) => receiptData(db, BigInt(params.id)),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/pos/receipts/:id/printed',
    access: { kind: 'permission', permission: 'invoices.view' },
    params: Params,
    handler: async ({ trx, request, params }) => ({
      body: await receiptPrinted(trx, request.auth, BigInt(params.id)),
    }),
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/pos/held-carts',
    access: sellAccess,
    handler: async ({ request }) => listHeldCarts(db, request.device!.id),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/pos/held-carts',
    access: sellAccess,
    body: HoldCartRequest,
    handler: async ({ trx, request, body }) => ({
      body: await holdCart(trx, request, body),
      status: 201,
    }),
  });
  for (const action of ['resume', 'discard'] as const) {
    defineWrite(app, {
      method: 'POST',
      url: `/api/v1/pos/held-carts/:id/${action}`,
      access: sellAccess,
      params: Params,
      handler: async ({ trx, request, params }) => ({
        body: await settleHeldCart(
          trx,
          request,
          BigInt(params.id),
          action === 'resume' ? 'resumed' : 'discarded',
        ),
      }),
    });
  }
}
