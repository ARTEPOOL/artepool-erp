/**
 * POS sales (POS-) and returns at the POS (decisions 0003, 0005, 0059–0062). One request is one
 * transaction (golden rule 4): the document and its lines, any oversell adjustment, the stock and
 * its cost, the split payment with change, the journal entries, the drawer event and the audit.
 * A retry with the same Idempotency-Key returns the first answer, so a sale is never made twice.
 */
import type { FastifyRequest } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import { quantityFromDb } from '@artepool/shared';
import type {
  PosPaymentResult,
  PosReturnRequest,
  PosReturnResponse,
  PosSaleRequest,
  PosSaleResponse,
  StockShortage,
} from '@artepool/shared/contracts';
import { recordEvent } from '../../platform/audit/events';
import type { DB } from '../../platform/db/schema.generated';
import { stamped, filledByDatabase } from '../../platform/db/stamped';
import { fieldError } from '../../platform/db/versioned';
import { AppError, ruleError } from '../../platform/errors/app-error';
import { consumeApproval } from '../approvals/service';
import { checkDropDue, drawerEvent, myOpenShift } from '../cash/drawer';
import { addMovement, incomingCost, today, valueOf } from '../inventory/service';
import { postEntry } from '../ledger/posting';
import { stockPosting } from '../ledger/stock-posting';
import {
  billTo,
  defaultBusinessLine,
  getDocument,
  insertItemLines,
  issueDraft,
  touch,
} from '../sales/documents';
import { prepareLines, milliToDb } from '../sales/lines';
import { createNote } from '../sales/notes';
import { allocate, insertPayment, postPayment } from '../sales/payments';
import { receiptData } from './receipts';

type Db = Kysely<DB> | Transaction<DB>;

export async function walkInCustomer(db: Db): Promise<bigint> {
  const c = await db
    .selectFrom('md.customers')
    .select('id')
    .where('is_walk_in', '=', true)
    .executeTakeFirstOrThrow();
  return c.id;
}

/** The line of business of POS sales: the setting `pos.default_business_line`, else the default. */
async function posBusinessLine(db: Db): Promise<bigint> {
  const { rows } = await sql<{ id: string | null }>`
    SELECT (SELECT b.id FROM md.business_lines b, sys.settings s
             WHERE s.key = 'pos.default_business_line' AND b.code = s.value #>> '{}' AND b.is_active)::text AS id`.execute(
    db,
  );
  return rows[0]?.id ? BigInt(rows[0].id) : defaultBusinessLine(db);
}

/** What the draft needs from stock, per stock item (kits by their components), in thousandths. */
async function stockNeeds(db: Db, documentId: bigint, warehouseId: bigint) {
  const { rows } = await sql<{
    item_id: string;
    code: string;
    name_ar: string;
    name_en: string;
    needed: string;
    available: string;
  }>`
    WITH needs AS (
      SELECT l.item_id, l.quantity AS qty
        FROM sales.document_lines l JOIN md.items i ON i.id = l.item_id
       WHERE l.document_id = ${documentId} AND l.line_kind = 'item' AND i.item_type = 'stock'
      UNION ALL
      SELECT c.component_item_id, l.quantity * c.quantity
        FROM sales.document_lines l
        JOIN md.items i ON i.id = l.item_id AND i.item_type = 'bundle'
        JOIN md.bundle_components c ON c.bundle_item_id = l.item_id
        JOIN md.items ci ON ci.id = c.component_item_id AND ci.item_type = 'stock'
       WHERE l.document_id = ${documentId} AND l.line_kind = 'item')
    SELECT n.item_id::text, i.code, i.name_ar, i.name_en, sum(n.qty)::text AS needed,
           coalesce(b.quantity, 0)::text AS available
      FROM needs n
      JOIN md.items i ON i.id = n.item_id
      LEFT JOIN inv.balances b ON b.item_id = n.item_id AND b.warehouse_id = ${warehouseId}
                              AND b.stock_status = 'available'
     GROUP BY n.item_id, i.code, i.name_ar, i.name_en, b.quantity
     ORDER BY i.code`.execute(db);
  return rows.map((r) => ({
    itemId: BigInt(r.item_id),
    code: r.code,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    needed: quantityFromDb(r.needed),
    available: quantityFromDb(r.available),
  }));
}

/**
 * Decision 0003: selling beyond stock needs a supervisor's approval; the missing quantity comes in
 * on an oversell adjustment (row 12) that waits for the storekeeper's review. Returns its number.
 */
async function coverShortage(
  trx: Transaction<DB>,
  documentId: bigint,
  warehouseId: bigint,
  approvalId: string | undefined,
  date: string,
): Promise<string | null> {
  const short = (await stockNeeds(trx, documentId, warehouseId)).filter(
    (n) => n.needed > n.available,
  );
  if (short.length === 0) return null;
  if (!approvalId) {
    const shortages: StockShortage[] = short.map((s) => ({
      itemId: s.itemId.toString(),
      code: s.code,
      nameAr: s.nameAr,
      nameEn: s.nameEn,
      neededMilli: s.needed.toString(),
      availableMilli: s.available.toString(),
    }));
    throw new AppError('PERMISSION_DENIED', 'Not enough stock: a supervisor must approve', {
      rule: 'OVERSELL_APPROVAL',
      permission: 'pos.oversell',
      shortages,
    });
  }
  await consumeApproval(trx, BigInt(approvalId), 'pos.oversell', `sales.documents:${documentId}`);
  const reason = await trx
    .selectFrom('sys.reason_codes')
    .select('id')
    .where('category', '=', 'oversell')
    .where('is_active', '=', true)
    .orderBy('id')
    .executeTakeFirstOrThrow();
  const adj = await trx
    .insertInto('inv.adjustments')
    .values(
      stamped('inv.adjustments', {
        kind: 'oversell',
        warehouse_id: warehouseId,
        adjustment_date: date,
        reason_code_id: reason.id,
        approval_id: BigInt(approvalId),
        sales_document_id: documentId,
      } as never),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  const movements: { stockStatus: string; valueFils: bigint }[] = [];
  for (const [i, s] of short.entries()) {
    const qty = s.needed - (s.available > 0n ? s.available : 0n);
    const cost = await incomingCost(trx, s.itemId, warehouseId, false);
    if (cost === null) {
      throw ruleError('COST_UNKNOWN', 'This item has no cost', { itemId: s.itemId.toString() });
    }
    const line = await trx
      .insertInto('inv.adjustment_lines')
      .values(
        stamped('inv.adjustment_lines', {
          adjustment_id: adj.id,
          line_no: i + 1,
          item_id: s.itemId,
          stock_status: 'available',
          target_status: null,
          quantity: milliToDb(qty),
          entered_unit_cost_4dp: cost,
          note: null,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    const m = await addMovement(trx, {
      type: 'oversell_in',
      date,
      itemId: s.itemId,
      warehouseId,
      status: 'available',
      quantityMilli: qty,
      value4dp: valueOf(qty, cost),
      adjustmentLineId: line.id,
    });
    await trx
      .updateTable('inv.adjustment_lines')
      .set({ value_4dp: m.value4dp, value_fils: m.valueFils })
      .where('id', '=', line.id)
      .execute();
    movements.push({ stockStatus: 'available', valueFils: m.valueFils });
  }
  const posted = await trx
    .updateTable('inv.adjustments')
    .set({ status: 'posted', total_value_fils: movements.reduce((t, m) => t + m.valueFils, 0n) })
    .where('id', '=', adj.id)
    .returning('doc_number')
    .executeTakeFirstOrThrow();
  await postEntry(trx, {
    date,
    source: { type: 'inventory_adjustment', id: adj.id },
    amounts: stockPosting('oversell', movements),
  });
  return posted.doc_number;
}

/** The POS methods of the request; card parts carry the slip's approval code only (0061). */
async function posMethods(db: Db, ids: string[]) {
  const rows = await db
    .selectFrom('md.payment_methods')
    .select([
      'id',
      'kind',
      'name_ar',
      'name_en',
      'opens_drawer',
      'gives_change',
      'in_pos',
      'is_active',
    ])
    .where(
      'id',
      'in',
      ids.map((i) => BigInt(i)),
    )
    .execute();
  return new Map(rows.map((r) => [r.id.toString(), r]));
}

async function paymentResults(db: Db, ids: bigint[]): Promise<PosPaymentResult[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom('sales.payments as p')
    .innerJoin('md.payment_methods as m', 'm.id', 'p.payment_method_id')
    .select([
      'p.id',
      'p.doc_number',
      'm.name_ar',
      'm.name_en',
      'p.method_kind',
      'p.amount_fils',
      'p.tendered_fils',
      'p.change_fils',
      'p.reference',
    ])
    .where('p.id', 'in', ids)
    .orderBy('p.id')
    .execute();
  return rows.map((r) => ({
    id: r.id.toString(),
    docNumber: r.doc_number,
    methodNameAr: r.name_ar,
    methodNameEn: r.name_en,
    methodKind: r.method_kind as PosPaymentResult['methodKind'],
    amountFils: r.amount_fils.toString(),
    tenderedFils: r.tendered_fils?.toString() ?? null,
    changeFils: r.change_fils?.toString() ?? null,
    reference: r.reference,
  }));
}

export async function sell(
  trx: Transaction<DB>,
  request: FastifyRequest,
  body: PosSaleRequest,
): Promise<PosSaleResponse> {
  const auth = request.auth!;
  const shift = await myOpenShift(trx, request.device, auth.userId);
  const register = await trx
    .selectFrom('cash.registers')
    .select(['warehouse_id', 'branch_id'])
    .where('id', '=', shift.registerId)
    .executeTakeFirstOrThrow();
  const customerId = body.customerId ? BigInt(body.customerId) : await walkInCustomer(trx);
  const businessLineId = await posBusinessLine(trx);
  const date = await today(trx);

  // Check the payments before any work: methods usable at the POS, change only from cash.
  const methods = await posMethods(
    trx,
    body.payments.map((p) => p.paymentMethodId),
  );
  for (const [i, p] of body.payments.entries()) {
    const m = methods.get(p.paymentMethodId);
    if (!m || !m.is_active || !m.in_pos)
      throw fieldError(`payments.${i}.paymentMethodId`, 'unknown');
    if (p.tenderedFils !== undefined) {
      if (!m.gives_change) throw fieldError(`payments.${i}.tenderedFils`, 'no_change');
      if (BigInt(p.tenderedFils) < BigInt(p.amountFils))
        throw fieldError(`payments.${i}.tenderedFils`, 'less_than_amount');
    }
    if (m.kind === 'card' && !p.approvalCode)
      throw fieldError(`payments.${i}.approvalCode`, 'required');
    if (m.kind !== 'card' && p.approvalCode)
      throw fieldError(`payments.${i}.approvalCode`, 'not_card');
  }

  const doc = await trx
    .insertInto('sales.documents')
    .values(
      filledByDatabase('sales.documents', {
        doc_type: 'invoice',
        channel: 'pos',
        branch_id: register.branch_id,
        business_line_id: businessLineId,
        warehouse_id: register.warehouse_id,
        device_id: sql<bigint>`sys.ctx_device_id()`,
        shift_id: shift.id,
        pos_cart_id: body.cartId,
        customer_id: customerId,
        ...(await billTo(trx, customerId)),
        doc_discount_fils: BigInt(body.docDiscountFils ?? '0'),
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  const rows = await prepareLines(trx, {
    lines: body.lines,
    docDiscountFils: BigInt(body.docDiscountFils ?? '0'),
    businessLineId,
    priceLevelId: null,
  });
  await insertItemLines(trx, doc.id, rows);
  await touch(trx, doc.id);

  // Decision 0005: lines removed before payment, no approval, always in the audit log.
  if (body.removals && body.removals.length > 0) {
    await recordEvent(trx, 'pos.cart_removed_lines', {
      entityType: 'sales.documents',
      entityId: doc.id,
      data: { cartId: body.cartId, removals: body.removals },
    });
  }

  const oversell = await coverShortage(
    trx,
    doc.id,
    register.warehouse_id,
    body.oversellApprovalId,
    date,
  );
  await issueDraft(trx, doc.id, {
    ...(body.approvalId ? { approvalId: body.approvalId } : {}),
    ...(body.priceApprovalId ? { priceApprovalId: body.priceApprovalId } : {}),
    ...(body.creditApprovalId ? { creditApprovalId: body.creditApprovalId } : {}),
  });

  const issued = await trx
    .selectFrom('sales.documents')
    .select(['total_fils'])
    .where('id', '=', doc.id)
    .executeTakeFirstOrThrow();
  const paying = body.payments.reduce((s, p) => s + BigInt(p.amountFils), 0n);
  if (paying > issued.total_fils) throw ruleError('PAYMENT_MISMATCH', 'More is paid than is due');

  const paymentIds: bigint[] = [];
  let change = 0n;
  let opensDrawer = false;
  for (const p of body.payments) {
    const m = methods.get(p.paymentMethodId)!;
    const tendered = p.tenderedFils !== undefined ? BigInt(p.tenderedFils) : null;
    const pay = await insertPayment(trx, {
      kind: 'receipt',
      customerId,
      part: {
        paymentMethodId: p.paymentMethodId,
        amountFils: p.amountFils,
        ...(p.approvalCode ? { reference: p.approvalCode } : {}),
      },
      date,
      pos: { shiftId: shift.id, tenderedFils: tendered },
    });
    await allocate(trx, pay.id, { documentId: doc.id }, BigInt(p.amountFils));
    await postPayment(trx, pay.id);
    paymentIds.push(pay.id);
    if (tendered !== null) change += tendered - BigInt(p.amountFils);
    if (m.opens_drawer) opensDrawer = true;
  }
  if (opensDrawer) {
    await drawerEvent(trx, {
      registerId: shift.registerId,
      shiftId: shift.id,
      type: 'open_sale',
      salesDocumentId: doc.id,
    });
  }
  if (body.heldCartId) await closeHeldCart(trx, BigInt(body.heldCartId), 'resumed');

  return {
    receipt: await receiptData(trx, doc.id),
    document: await getDocument(trx, doc.id),
    payments: await paymentResults(trx, paymentIds),
    changeFils: change.toString(),
    opensDrawer,
    oversellAdjustmentNumber: oversell,
    dropDue: await checkDropDue(trx, shift.id),
  };
}

/** A held cart that is resumed or discarded leaves the list. */
export async function closeHeldCart(
  trx: Transaction<DB>,
  id: bigint,
  status: 'resumed' | 'discarded',
) {
  await trx
    .updateTable('sales.held_carts')
    .set({ status, closed_at: sql`now()`, closed_by: sql`sys.require_user()` })
    .where('id', '=', id)
    .where('status', '=', 'held')
    .execute();
}

// ---------------------------------------------------------------------------------------------
// Returns at the POS (decision 0060)
// ---------------------------------------------------------------------------------------------

/**
 * A return makes a credit note linked to the original POS invoice (which never changes), brings
 * the goods back, and pays the money back from the drawer of the shift open NOW, whichever shift
 * sold it. What was paid by card goes back to the card; the rest is cash.
 */
export async function posReturn(
  trx: Transaction<DB>,
  request: FastifyRequest,
  body: PosReturnRequest,
): Promise<PosReturnResponse> {
  const auth = request.auth!;
  const shift = await myOpenShift(trx, request.device, auth.userId);
  const original = await trx
    .selectFrom('sales.documents')
    .select(['id', 'channel', 'customer_id', 'status', 'doc_type'])
    .where('id', '=', BigInt(body.originalDocumentId))
    .executeTakeFirst();
  if (!original || original.status !== 'issued' || original.doc_type !== 'invoice') {
    throw ruleError('NOTE_ORIGINAL', 'A return refers to an issued invoice');
  }
  if (original.channel !== 'pos')
    throw ruleError('NOT_POS_SALE', 'Only a POS sale is returned here');

  // The credit note, at the POS, on this shift; the supervisor's approval is always used (0060).
  const note = await createNote(
    trx,
    // Never the cashier's own credit_notes.issue: the approval stands for the supervisor.
    { permissions: new Set<string>() },
    {
      kind: 'credit_note',
      originalDocumentId: body.originalDocumentId,
      reasonCodeId: body.reasonCodeId,
      reasonText: body.reasonText,
      lines: body.lines,
      approvalId: body.approvalId,
    },
    { shiftId: shift.id },
  );

  // Card first, up to what the card paid and was not refunded yet; the rest in cash.
  const left = await trx
    .selectFrom('sales.documents')
    .select(sql<string>`total_fils - settled_fils`.as('left'))
    .where('id', '=', BigInt(note.id))
    .executeTakeFirstOrThrow();
  let remaining = BigInt(left.left);
  const paidBy = await trx
    .selectFrom('sales.payment_allocations as a')
    .innerJoin('sales.payments as p', 'p.id', 'a.payment_id')
    .select(['p.payment_method_id', 'p.method_kind', sql<string>`sum(a.amount_fils)`.as('paid')])
    .where('a.document_id', '=', original.id)
    .where('p.status', '=', 'posted')
    .groupBy(['p.payment_method_id', 'p.method_kind'])
    .execute();
  const refundedByCard = await trx
    .selectFrom('sales.payments as p')
    .innerJoin('sales.payment_allocations as a', 'a.payment_id', 'p.id')
    .innerJoin('sales.documents as n', 'n.id', 'a.document_id')
    .select(['p.payment_method_id', sql<string>`sum(a.amount_fils)`.as('refunded')])
    .where('n.original_document_id', '=', original.id)
    .where('p.payment_kind', '=', 'refund')
    .where('p.status', '=', 'posted')
    .groupBy('p.payment_method_id')
    .execute();
  const refunds: { methodId: bigint; amount: bigint }[] = [];
  for (const p of paidBy.filter((x) => x.method_kind === 'card')) {
    const already = BigInt(
      refundedByCard.find((r) => r.payment_method_id === p.payment_method_id)?.refunded ?? '0',
    );
    const canGo = BigInt(p.paid) - already;
    const amount = canGo < remaining ? canGo : remaining;
    if (amount > 0n) {
      refunds.push({ methodId: p.payment_method_id, amount });
      remaining -= amount;
    }
  }
  if (remaining > 0n) {
    const cash = await trx
      .selectFrom('md.payment_methods')
      .select('id')
      .where('kind', '=', 'cash')
      .where('in_pos', '=', true)
      .where('is_active', '=', true)
      .orderBy('sort_order')
      .executeTakeFirstOrThrow();
    refunds.push({ methodId: cash.id, amount: remaining });
  }
  const ids: bigint[] = [];
  const date = await today(trx);
  let opensDrawer = false;
  for (const r of refunds) {
    const pay = await insertPayment(trx, {
      kind: 'refund',
      customerId: original.customer_id,
      part: { paymentMethodId: r.methodId.toString(), amountFils: r.amount.toString() },
      date,
      pos: { shiftId: shift.id },
    });
    await allocate(trx, pay.id, { documentId: BigInt(note.id) }, r.amount);
    await postPayment(trx, pay.id);
    ids.push(pay.id);
    const m = await trx
      .selectFrom('md.payment_methods')
      .select('opens_drawer')
      .where('id', '=', r.methodId)
      .executeTakeFirstOrThrow();
    if (m.opens_drawer) {
      opensDrawer = true;
      await drawerEvent(trx, {
        registerId: shift.registerId,
        shiftId: shift.id,
        type: 'open_payment',
        paymentId: pay.id,
      });
    }
  }
  return {
    receipt: await receiptData(trx, BigInt(note.id)),
    creditNote: await getDocument(trx, BigInt(note.id)),
    refunds: await paymentResults(trx, ids),
    opensDrawer,
  };
}
