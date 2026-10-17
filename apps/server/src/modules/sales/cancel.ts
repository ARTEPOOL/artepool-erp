/**
 * Cancelling or editing an issued A4 invoice with the owner's approval (decision 0072). An issued
 * tax invoice never changes and is never deleted (golden rules 2 and 3): it is cancelled by a
 * credit note for the whole invoice, with the goods back in stock, the VAT reversed and the paid
 * money refunded at once. "Edit" does the same in one transaction and opens a new draft copied
 * from it, where the customer and the lines can be changed before it is issued with a new number.
 */
import type { FastifyRequest } from 'fastify';
import type { Transaction } from 'kysely';
import { quantityFromDb } from '@artepool/shared';
import type {
  CancelInvoiceRequest,
  CancelInvoiceResponse,
  SaveInvoiceRequest,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { fieldError } from '../../platform/db/versioned';
import { AppError, ruleError } from '../../platform/errors/app-error';
import { consumeApproval } from '../approvals/service';
import { saveInvoiceDraft } from './documents';
import { createNote } from './notes';

export async function cancelInvoice(
  trx: Transaction<DB>,
  request: FastifyRequest,
  id: bigint,
  body: CancelInvoiceRequest,
): Promise<CancelInvoiceResponse> {
  const auth = request.auth!;
  const invoice = await trx
    .selectFrom('sales.documents')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (!invoice) throw new AppError('NOT_FOUND', 'No such document');
  if (invoice.row_version !== body.rowVersion) {
    throw new AppError('STALE_VERSION', 'The invoice changed meanwhile');
  }
  if (
    invoice.status !== 'issued' ||
    invoice.doc_type !== 'invoice' ||
    invoice.channel !== 'office'
  ) {
    throw ruleError('INVOICE_CANCEL_A4_ONLY', 'Only an issued A4 invoice is cancelled this way');
  }

  // The owner's permission, or the owner's approval for this very invoice.
  if (!auth.permissions.has('invoices.cancel')) {
    if (!body.approvalId) {
      throw new AppError('PERMISSION_DENIED', 'Missing permission invoices.cancel', {
        permission: 'invoices.cancel',
      });
    }
    const context = await consumeApproval(
      trx,
      BigInt(body.approvalId),
      'invoices.cancel',
      `sales.documents:${id}:cancel`,
    );
    if (context.documentId !== undefined && context.documentId !== id.toString()) {
      throw new AppError('APPROVAL_INVALID', 'The approval was given for another invoice');
    }
  }

  // A note already issued against it, or earlier payments deducted: a credit note by hand instead.
  const note = await trx
    .selectFrom('sales.documents')
    .select('id')
    .where('original_document_id', '=', id)
    .where('status', '=', 'issued')
    .executeTakeFirst();
  if (note) throw ruleError('INVOICE_HAS_NOTES', 'A note was already issued against this invoice');
  const lines = await trx
    .selectFrom('sales.document_lines')
    .selectAll()
    .where('document_id', '=', id)
    .orderBy('line_no')
    .execute();
  if (lines.some((l) => l.line_kind === 'advance_deduction')) {
    throw ruleError('INVOICE_HAS_DEDUCTIONS', 'This invoice deducts earlier payments');
  }
  const items = lines.filter((l) => l.line_kind === 'item');

  // What the customer paid goes back now, all of it.
  const paid = invoice.settled_fils;
  const refunded = (body.refund ?? []).reduce((sum, p) => sum + BigInt(p.amountFils), 0n);
  if (refunded !== paid) throw fieldError('refund', 'must_equal_paid');

  const reason = await trx
    .selectFrom('sys.reason_codes')
    .select('id')
    .where('category', '=', 'credit_note')
    .where('code', '=', body.mode === 'edit' ? 'INVOICE_EDITED' : 'INVOICE_CANCELLED')
    .executeTakeFirstOrThrow();
  // The owner approved the cancellation; that covers the credit note it is made of.
  const creditNote = await createNote(
    trx,
    { ...auth, permissions: new Set([...auth.permissions, 'credit_notes.issue']) },
    {
      kind: 'credit_note',
      originalDocumentId: id.toString(),
      reasonCodeId: reason.id.toString(),
      reasonText: body.reason,
      lines: items.map((l) => ({
        originalLineId: l.id.toString(),
        quantityMilli: quantityFromDb(l.quantity).toString(),
        returnStockStatus: 'available' as const,
      })),
      ...(body.refund && body.refund.length > 0 ? { refund: body.refund } : {}),
    },
  );

  let draftId: bigint | null = null;
  if (body.mode === 'edit') {
    // The same customer, details and lines, as a new draft to change and issue.
    const copy: SaveInvoiceRequest = {
      customerId: invoice.customer_id.toString(),
      businessLineId: invoice.business_line_id.toString(),
      billToName: invoice.bill_to_name,
      ...(invoice.bill_to_address ? { billToAddress: invoice.bill_to_address } : {}),
      ...(invoice.customer_po ? { customerPo: invoice.customer_po } : {}),
      ...(invoice.notes ? { notes: invoice.notes } : {}),
      docDiscountFils: invoice.doc_discount_fils.toString(),
      lines: items.map((l) => ({
        itemId: l.item_id!.toString(),
        quantityMilli: quantityFromDb(l.quantity).toString(),
        unitPrice4dp: l.unit_price_4dp.toString(),
        ...(l.line_discount_bp !== null
          ? { lineDiscountBp: l.line_discount_bp }
          : { lineDiscountFils: l.line_discount_fils.toString() }),
        descriptionAr: l.description_ar,
        descriptionEn: l.description_en,
      })),
    };
    draftId = await saveInvoiceDraft(trx, null, copy);
  }
  return { creditNote, draftId: draftId?.toString() ?? null };
}
