/**
 * Credit notes (CN-) and debit notes (DN-) against an issued invoice. The original never changes.
 * A credit note returns goods to sellable or defective stock at the cost they left with (0015),
 * corrects a price, or reverses a payment invoice when the work is cancelled (0013). It is applied
 * to the original while that is unpaid; anything left is refunded now or kept as the customer's
 * credit. Posting map rows 7–10.
 */
import { sql, type Transaction } from 'kysely';
import { quantityFromDb, roundDiv } from '@artepool/shared';
import type { CreateNoteRequest, DocumentDetail } from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { filledByDatabase } from '../../platform/db/stamped';
import { fieldError } from '../../platform/db/versioned';
import { AppError, ruleError } from '../../platform/errors/app-error';
import { addMovement, today } from '../inventory/service';
import { getDocument, issueDraft, touch, useApproval, type Auth } from './documents';
import { milliToDb } from './lines';
import { refund } from './payments';

async function applyCredit(trx: Transaction<DB>, noteId: bigint, targetId: bigint) {
  const n = await trx
    .selectFrom('sales.documents')
    .select(sql<bigint>`total_fils - settled_fils`.as('left'))
    .where('id', '=', noteId)
    .executeTakeFirstOrThrow();
  const t = await trx
    .selectFrom('sales.documents')
    .select(sql<bigint>`total_fils - settled_fils`.as('left'))
    .where('id', '=', targetId)
    .executeTakeFirstOrThrow();
  const amount = BigInt(n.left) < BigInt(t.left) ? BigInt(n.left) : BigInt(t.left);
  if (amount <= 0n) return;
  await trx
    .insertInto('sales.credit_allocations')
    .values(
      filledByDatabase('sales.credit_allocations', {
        credit_note_id: noteId,
        invoice_id: targetId,
        amount_fils: amount,
      }),
    )
    .execute();
}

/** Goods coming back: one return movement per stock item (or kit component), at their old cost. */
async function returnStock(
  trx: Transaction<DB>,
  noteLineId: bigint,
  originalLineId: bigint,
  quantityMilli: bigint,
  status: 'available' | 'defective',
  warehouseId: bigint,
  date: string,
): Promise<bigint> {
  const original = await trx
    .selectFrom('sales.document_lines')
    .select('quantity')
    .where('id', '=', originalLineId)
    .executeTakeFirstOrThrow();
  const originalQty = quantityFromDb(original.quantity);
  const moved = await trx
    .selectFrom('inv.movements')
    .select(['item_id', 'quantity', 'value_fils'])
    .where('sales_document_line_id', '=', originalLineId)
    .execute();
  let cost = 0n;
  for (const m of moved) {
    const outQty = -quantityFromDb(m.quantity);
    const qty = (outQty * quantityMilli) / originalQty;
    // The value that left with these goods, in 4 decimals (fils × 100), in proportion.
    const value4dp = roundDiv(-m.value_fils * 100n * quantityMilli, originalQty);
    const r = await addMovement(trx, {
      type: 'sale_return',
      date,
      itemId: m.item_id,
      warehouseId,
      status,
      quantityMilli: qty,
      value4dp,
      salesDocumentLineId: noteLineId,
    });
    cost += r.valueFils < 0n ? -r.valueFils : r.valueFils;
  }
  return cost;
}

export async function createNote(
  trx: Transaction<DB>,
  auth: Auth,
  body: CreateNoteRequest,
  /** A return at the POS: the note belongs to the drawer shift open now (decision 0060). */
  pos?: { shiftId: bigint },
): Promise<DocumentDetail> {
  const original = await trx
    .selectFrom('sales.documents')
    .selectAll()
    .where('id', '=', BigInt(body.originalDocumentId))
    .executeTakeFirst();
  if (
    !original ||
    original.status !== 'issued' ||
    !['invoice', 'advance_invoice'].includes(original.doc_type)
  ) {
    throw ruleError('NOTE_ORIGINAL', 'A note refers to an issued invoice');
  }
  // Credit notes need credit_notes.issue, or a supervisor's approval for it.
  let approvalId: bigint | null = null;
  if (body.kind === 'credit_note' && !auth?.permissions.has('credit_notes.issue')) {
    if (!body.approvalId) {
      throw new AppError('PERMISSION_DENIED', 'Missing permission credit_notes.issue', {
        permission: 'credit_notes.issue',
      });
    }
    approvalId = await useApproval(
      trx,
      body.approvalId,
      ['credit_notes.issue'],
      `sales.documents:note`,
    );
  }
  const date = body.issueDate ?? (await today(trx));
  const note = await trx
    .insertInto('sales.documents')
    .values(
      filledByDatabase('sales.documents', {
        doc_type: body.kind,
        channel: pos ? 'pos' : 'office',
        shift_id: pos?.shiftId ?? null,
        branch_id: original.branch_id,
        business_line_id: original.business_line_id,
        warehouse_id: original.warehouse_id,
        device_id: sql<bigint>`sys.ctx_device_id()`,
        customer_id: original.customer_id,
        bill_to_name: original.bill_to_name,
        bill_to_name_alt: original.bill_to_name_alt,
        bill_to_address: original.bill_to_address,
        bill_to_phone: original.bill_to_phone,
        issue_date: date,
        original_document_id: original.id,
        quotation_id: original.quotation_id,
        reason_code_id: BigInt(body.reasonCodeId),
        reason_text: body.reasonText,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();

  if (original.doc_type === 'advance_invoice') {
    // Work cancelled: reverse (part of) the payment invoice's advance, with its VAT.
    if (body.kind !== 'credit_note' || !body.advanceAmountFils)
      throw fieldError('advanceAmountFils', 'required');
    const line = await trx
      .selectFrom('sales.document_lines')
      .select(['business_line_id', 'vat_category_id'])
      .where('document_id', '=', original.id)
      .orderBy('line_no')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('sales.document_lines')
      .values(
        filledByDatabase('sales.document_lines', {
          document_id: note.id,
          line_no: 1,
          line_kind: 'advance',
          description_ar: `إلغاء دفعة ${original.doc_number}`,
          description_en: `Cancelled payment ${original.doc_number}`,
          business_line_id: line.business_line_id,
          quantity: '1.000',
          unit_price_4dp: BigInt(body.advanceAmountFils) * 100n,
          vat_category_id: line.vat_category_id,
          net_fils: 0n,
          vat_fils: 0n,
          gross_fils: 0n,
        }),
      )
      .execute();
  } else {
    if (!body.lines || body.lines.length === 0) throw fieldError('lines', 'required');
    for (const [i, l] of body.lines.entries()) {
      const o = await trx
        .selectFrom('sales.document_lines as ol')
        .innerJoin('md.items as it', 'it.id', 'ol.item_id')
        .select([
          'ol.id',
          'ol.item_id',
          'ol.description_ar',
          'ol.description_en',
          'ol.unit_id',
          'ol.business_line_id',
          'ol.quantity',
          'ol.unit_price_4dp',
          'ol.line_discount_fils',
          'ol.doc_discount_alloc_fils',
          'ol.vat_category_id',
          'ol.document_id',
          'it.item_type',
        ])
        .where('ol.id', '=', BigInt(l.originalLineId))
        .where('ol.line_kind', '=', 'item')
        .executeTakeFirst();
      if (!o || o.document_id !== original.id)
        throw fieldError(`lines.${i}.originalLineId`, 'unknown');
      const qty = BigInt(l.quantityMilli);
      const originalQty = quantityFromDb(o.quantity);
      // At the original price with its discount in proportion, unless a correction price is given.
      const correcting = l.unitPrice4dp !== undefined;
      const discount = correcting
        ? 0n
        : roundDiv((o.line_discount_fils + o.doc_discount_alloc_fils) * qty, originalQty);
      const returning =
        body.kind === 'credit_note' && ['stock', 'bundle'].includes(o.item_type)
          ? (l.returnStockStatus ?? null)
          : null;
      const row = await trx
        .insertInto('sales.document_lines')
        .values(
          filledByDatabase('sales.document_lines', {
            document_id: note.id,
            line_no: i + 1,
            line_kind: 'item',
            item_id: o.item_id,
            description_ar: o.description_ar,
            description_en: o.description_en,
            unit_id: o.unit_id,
            business_line_id: o.business_line_id,
            quantity: milliToDb(qty),
            unit_price_4dp: correcting ? BigInt(l.unitPrice4dp!) : o.unit_price_4dp,
            line_discount_fils: discount,
            vat_category_id: o.vat_category_id,
            original_line_id: o.id,
            return_stock_status: returning,
            net_fils: 0n,
            vat_fils: 0n,
            gross_fils: 0n,
          }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();
      if (returning) {
        const cost = await returnStock(
          trx,
          row.id,
          o.id,
          qty,
          returning,
          original.warehouse_id,
          date,
        );
        await trx
          .updateTable('sales.document_lines')
          .set({ cost_fils: cost })
          .where('id', '=', row.id)
          .execute();
      }
    }
  }
  await touch(trx, note.id);
  if (approvalId !== null) {
    await trx
      .updateTable('sales.documents')
      .set({ approval_id: approvalId })
      .where('id', '=', note.id)
      .execute();
  }
  // Notes are issued straight away; their return movements were made above.
  await issueDraft(trx, note.id);

  if (body.kind === 'credit_note') {
    if (original.settlement_status !== 'settled') await applyCredit(trx, note.id, original.id);
    if (body.refund && body.refund.length > 0) {
      const left = await trx
        .selectFrom('sales.documents')
        .select(sql<bigint>`total_fils - settled_fils`.as('left'))
        .where('id', '=', note.id)
        .executeTakeFirstOrThrow();
      let remaining = BigInt(left.left);
      for (const part of body.refund) {
        const amount = BigInt(part.amountFils);
        if (amount > remaining) throw fieldError('refund', 'more_than_credit');
        await refund(trx, original.customer_id, part, [{ documentId: note.id, amount }], null);
        remaining -= amount;
      }
    }
  }
  return getDocument(trx, note.id);
}

/** The credit note that reverses a payment invoice whose payment was reversed (decision 0048). */
export async function creditWholeAdvance(
  trx: Transaction<DB>,
  advanceId: bigint,
  reasonCodeId: bigint,
) {
  const a = await trx
    .selectFrom('sales.documents')
    .select([
      'customer_id',
      sql<bigint>`net_fils - advance_used_net_fils + vat_fils - advance_used_vat_fils`.as('left'),
    ])
    .where('id', '=', advanceId)
    .executeTakeFirstOrThrow();
  if (BigInt(a.left) <= 0n) return;
  await createNote(
    trx,
    { permissions: new Set(['credit_notes.issue']) },
    {
      kind: 'credit_note',
      originalDocumentId: advanceId.toString(),
      reasonCodeId: reasonCodeId.toString(),
      reasonText: 'Payment reversed',
      advanceAmountFils: BigInt(a.left).toString(),
    },
  );
}
