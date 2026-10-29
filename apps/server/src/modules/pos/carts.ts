/**
 * The POS state of this PC (its drawer, the open shift, the payment methods) and held carts:
 * a cart is put aside and resumed later on the same PC; nothing is sold until it is paid.
 */
import type { FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import type { HeldCart, HoldCartRequest, PosState } from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { settingsOf } from '../printing/service';
import { filledByDatabase } from '../../platform/db/stamped';
import { AppError } from '../../platform/errors/app-error';
import { expectedCash, openShiftOnDevice, registerOf, settingBigint } from '../cash/drawer';
import { shiftSummary } from '../cash/shifts';
import { closeHeldCart, walkInCustomer } from './sales';
import { isOwner } from '../auth/owner';

type Db = Kysely<DB> | Transaction<DB>;

export async function posState(db: Db, request: FastifyRequest): Promise<PosState> {
  const device = request.device!;
  const userId = request.auth!.userId;
  const isPos = device.kind === 'pos';
  const register = isPos ? await registerOf(db, device.id) : undefined;
  const open = isPos ? await openShiftOnDevice(db, device.id) : undefined;
  const mine = open && open.cashier_id === userId ? open : undefined;
  const methods = await db
    .selectFrom('md.payment_methods')
    .select(['id', 'code', 'name_ar', 'name_en', 'kind', 'opens_drawer', 'gives_change'])
    .where('in_pos', '=', true)
    .where('is_active', '=', true)
    .orderBy('sort_order')
    .execute();
  const denominations = await db
    .selectFrom('md.cash_denominations')
    .select(['id', 'value_fils', 'kind'])
    .where('is_active', '=', true)
    .orderBy('value_fils', 'desc')
    .execute();
  // The receipt's language is part of its template (decision 0064).
  const { language } = await settingsOf(db, null, 'receipt_thermal');
  const limit = await settingBigint(db, 'cash.drop_alert_fils');
  const cash = mine ? await expectedCash(db, mine.id) : null;
  const dropDue = cash !== null && limit !== null ? cash > limit : false;
  // The owner sees the expected cash on "My shift"; everyone else counts blind (0006, 0080).
  const owner = cash !== null && (await isOwner(db, userId));
  const last = mine
    ? await db
        .selectFrom('sales.documents')
        .select(['id', 'doc_number', 'issued_at', 'total_fils'])
        .where('shift_id', '=', mine.id)
        .where('doc_type', '=', 'invoice')
        .where('status', '=', 'issued')
        .orderBy('issued_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst()
    : undefined;
  return {
    isPosDevice: isPos,
    registerId: register?.id.toString() ?? null,
    shift: mine ? await shiftSummary(db, mine.id) : null,
    drawerBusyWith:
      open && !mine
        ? { displayNameAr: open.display_name_ar, displayNameEn: open.display_name_en }
        : null,
    walkInCustomerId: (await walkInCustomer(db)).toString(),
    paymentMethods: methods.map((m) => ({
      id: m.id.toString(),
      code: m.code,
      nameAr: m.name_ar,
      nameEn: m.name_en,
      kind: m.kind as PosState['paymentMethods'][number]['kind'],
      opensDrawer: m.opens_drawer,
      givesChange: m.gives_change,
    })),
    denominations: denominations.map((d) => ({
      id: d.id.toString(),
      valueFils: d.value_fils.toString(),
      kind: d.kind as 'note' | 'coin',
    })),
    receiptLanguage: language,
    dropDue,
    expectedCashFils: owner && cash !== null ? cash.toString() : null,
    lastSale:
      last && last.doc_number && last.issued_at
        ? {
            id: last.id.toString(),
            docNumber: last.doc_number,
            issuedAt: last.issued_at.toISOString(),
            totalFils: last.total_fils.toString(),
          }
        : null,
  };
}

function heldBase(db: Db) {
  return db
    .selectFrom('sales.held_carts as h')
    .innerJoin('auth.users as u', 'u.id', 'h.user_id')
    .leftJoin('md.customers as c', 'c.id', 'h.customer_id')
    .select([
      'h.id',
      'h.cart_id',
      'h.label',
      'h.customer_id',
      'c.name as customer_name',
      'h.held_at',
      'u.display_name_ar',
      'u.display_name_en',
      'h.cart',
    ]);
}

const heldItem = (
  r: Awaited<ReturnType<ReturnType<typeof heldBase>['executeTakeFirstOrThrow']>>,
): HeldCart => ({
  id: r.id.toString(),
  cartId: r.cart_id,
  label: r.label,
  customerId: r.customer_id?.toString() ?? null,
  customerName: r.customer_name,
  heldAt: r.held_at.toISOString(),
  heldByName: { displayNameAr: r.display_name_ar, displayNameEn: r.display_name_en },
  cart: r.cart as Record<string, unknown>,
});

/** The carts held on this PC. */
export async function listHeldCarts(db: Db, deviceId: bigint): Promise<HeldCart[]> {
  const rows = await heldBase(db)
    .where('h.device_id', '=', deviceId)
    .where('h.status', '=', 'held')
    .orderBy('h.id')
    .execute();
  return rows.map(heldItem);
}

export async function holdCart(
  trx: Transaction<DB>,
  request: FastifyRequest,
  body: HoldCartRequest,
): Promise<HeldCart> {
  const device = request.device!;
  const register = await registerOf(trx, device.id);
  const row = await trx
    .insertInto('sales.held_carts')
    .values(
      filledByDatabase('sales.held_carts', {
        cart_id: body.cartId,
        device_id: device.id,
        register_id: register?.id ?? null,
        customer_id: body.customerId ? BigInt(body.customerId) : null,
        label: body.label ?? null,
        cart: JSON.stringify(body.cart),
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return heldItem(await heldBase(trx).where('h.id', '=', row.id).executeTakeFirstOrThrow());
}

/** Resume (the cart comes back to the screen) or discard a cart held on this PC. */
export async function settleHeldCart(
  trx: Transaction<DB>,
  request: FastifyRequest,
  id: bigint,
  status: 'resumed' | 'discarded',
): Promise<HeldCart> {
  const cart = await heldBase(trx)
    .select(['h.device_id', 'h.status'])
    .where('h.id', '=', id)
    .executeTakeFirst();
  if (!cart || cart.device_id !== request.device!.id || cart.status !== 'held') {
    throw new AppError('NOT_FOUND', 'No such held cart on this PC');
  }
  await closeHeldCart(trx, id, status);
  return heldItem(cart);
}
