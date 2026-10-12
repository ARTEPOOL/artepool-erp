/**
 * Receipts (RCT-), refunds (RFD-) and reversals (RVS-). A receipt settles the documents chosen,
 * or the oldest open ones first (decision 0052); whatever settles nothing becomes an advance or
 * progress payment with its own tax invoice (INV-, decision 0013), issued in the same transaction.
 * A bounced cheque is reversed, and the payment invoice it created is reversed by a credit note
 * (0048). Every payment has its journal entry (posting map rows 3, 5, 10, 11).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  PaymentDetail,
  PaymentItem,
  PaymentPart,
  PaymentsQuery,
  PaymentsResponse,
  ReceivePaymentRequest,
  ReceivePaymentResponse,
  ReversePaymentRequest,
  DocType,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { filledByDatabase } from '../../platform/db/stamped';
import { fieldError } from '../../platform/db/versioned';
import { AppError, ruleError } from '../../platform/errors/app-error';
import { today } from '../inventory/service';
import { postEntry } from '../ledger/posting';
import { paymentPosting } from '../ledger/sales-posting';
import {
  billTo,
  defaultBranch,
  defaultBusinessLine,
  getDocument,
  issueDraft,
  useApproval,
} from './documents';
import { warehouseOf } from '../inventory/service';

type Db = Kysely<DB> | Transaction<DB>;

/** The account money goes to: in the office the method's office account (decision 0047). */
async function methodAccount(db: Db, methodId: bigint, channel: 'office' | 'pos'): Promise<bigint> {
  const m = await db
    .selectFrom('md.payment_methods')
    .select(['gl_account_id', 'office_gl_account_id'])
    .where('id', '=', methodId)
    .executeTakeFirst();
  if (!m) throw fieldError('paymentMethodId', 'unknown');
  return channel === 'office' ? (m.office_gl_account_id ?? m.gl_account_id) : m.gl_account_id;
}

async function insertPayment(
  trx: Transaction<DB>,
  p: {
    kind: 'receipt' | 'refund' | 'reversal';
    customerId: bigint;
    part: PaymentPart;
    date: string;
    reversalOfId?: bigint;
    reasonCodeId?: bigint;
    approvalId?: bigint | null;
    quotationId?: bigint | null;
    notes?: string | null;
  },
) {
  return trx
    .insertInto('sales.payments')
    .values(
      filledByDatabase('sales.payments', {
        payment_kind: p.kind,
        reversal_of_id: p.reversalOfId ?? null,
        customer_id: p.customerId,
        payment_method_id: BigInt(p.part.paymentMethodId),
        amount_fils: BigInt(p.part.amountFils),
        reference: p.part.reference ?? null,
        cheque_date: p.part.chequeDate ?? null,
        cheque_bank: p.part.chequeBank ?? null,
        payment_date: p.date,
        channel: 'office',
        device_id: sql<bigint>`sys.ctx_device_id()`,
        reason_code_id: p.reasonCodeId ?? null,
        approval_id: p.approvalId ?? null,
        quotation_id: p.quotationId ?? null,
        notes: p.notes ?? null,
      }),
    )
    .returning(['id', 'doc_number'])
    .executeTakeFirstOrThrow();
}

async function allocate(
  trx: Transaction<DB>,
  paymentId: bigint,
  target: { documentId?: bigint; openingBalanceId?: bigint },
  amount: bigint,
) {
  await trx
    .insertInto('sales.payment_allocations')
    .values(
      filledByDatabase('sales.payment_allocations', {
        payment_id: paymentId,
        document_id: target.documentId ?? null,
        opening_balance_id: target.openingBalanceId ?? null,
        amount_fils: amount,
      }),
    )
    .execute();
}

async function postPayment(trx: Transaction<DB>, paymentId: bigint) {
  const p = await trx
    .selectFrom('sales.payments as p')
    .leftJoin('sales.payments as o', 'o.id', 'p.reversal_of_id')
    .select([
      'p.payment_kind',
      'p.customer_id',
      'p.amount_fils',
      'p.payment_method_id',
      'p.channel',
      'p.payment_date',
      'p.doc_number',
      'o.payment_kind as reversed_kind',
    ])
    .where('p.id', '=', paymentId)
    .executeTakeFirstOrThrow();
  await postEntry(trx, {
    date: p.payment_date,
    source: { type: 'payment', id: paymentId },
    memo: p.doc_number,
    amounts: paymentPosting({
      kind: p.payment_kind as 'receipt' | 'refund' | 'reversal',
      reversedKind: (p.reversed_kind ?? undefined) as 'receipt' | 'refund' | undefined,
      customerId: p.customer_id,
      amountFils: p.amount_fils,
      methodAccountId: await methodAccount(trx, p.payment_method_id, p.channel as 'office' | 'pos'),
    }),
  });
}

/** The customer's open debts, oldest first: opening balance, then documents by date (0052). */
async function openDebts(db: Db, customerId: bigint) {
  const opening = await db
    .selectFrom('sales.opening_balances')
    .select(['id', sql<bigint>`amount_fils - settled_fils`.as('left')])
    .where('customer_id', '=', customerId)
    .where('direction', '=', 'receivable')
    .where(sql<boolean>`settled_fils < amount_fils`)
    .execute();
  const docs = await db
    .selectFrom('sales.documents')
    .select(['id', sql<bigint>`total_fils - settled_fils`.as('left')])
    .where('customer_id', '=', customerId)
    .where('status', '=', 'issued')
    .where('doc_type', 'in', ['invoice', 'debit_note'])
    .where('settlement_status', '<>', 'settled')
    .orderBy('issue_date')
    .orderBy('id')
    .execute();
  return [
    ...opening.map((o) => ({ openingBalanceId: o.id, left: BigInt(o.left) })),
    ...docs.map((d) => ({ documentId: d.id, left: BigInt(d.left) })),
  ];
}

/**
 * A payment invoice for money that settles nothing (decision 0013): one "advance" line whose
 * amount includes VAT at the agreed rate (5% by default), issued now.
 */
async function issueAdvanceInvoice(
  trx: Transaction<DB>,
  customerId: bigint,
  grossFils: bigint,
  opts: {
    date: string;
    quotationId?: bigint | null;
    businessLineId?: bigint;
    vatCategoryId?: bigint;
  },
): Promise<bigint> {
  const quotation = opts.quotationId
    ? await trx
        .selectFrom('sales.quotations')
        .select(['business_line_id', 'customer_id', 'doc_number'])
        .where('id', '=', opts.quotationId)
        .executeTakeFirst()
    : undefined;
  if (opts.quotationId && quotation?.customer_id !== customerId)
    throw fieldError('quotationId', 'unknown');
  const businessLineId =
    opts.businessLineId ?? quotation?.business_line_id ?? (await defaultBusinessLine(trx));
  const vatCategoryId =
    opts.vatCategoryId ??
    (
      await trx
        .selectFrom('md.vat_categories')
        .select('id')
        .where('code', '=', 'SR')
        .executeTakeFirstOrThrow()
    ).id;
  const doc = await trx
    .insertInto('sales.documents')
    .values(
      filledByDatabase('sales.documents', {
        doc_type: 'advance_invoice',
        channel: 'office',
        branch_id: await defaultBranch(trx),
        business_line_id: businessLineId,
        warehouse_id: await warehouseOf(trx, undefined),
        device_id: sql<bigint>`sys.ctx_device_id()`,
        customer_id: customerId,
        ...(await billTo(trx, customerId)),
        issue_date: opts.date,
        quotation_id: opts.quotationId ?? null,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('sales.document_lines')
    .values(
      filledByDatabase('sales.document_lines', {
        document_id: doc.id,
        line_no: 1,
        line_kind: 'advance',
        description_ar: quotation ? `دفعة على عرض السعر ${quotation.doc_number}` : 'دفعة مقدمة',
        description_en: quotation
          ? `Payment on quotation ${quotation.doc_number}`
          : 'Advance payment',
        business_line_id: businessLineId,
        quantity: '1.000',
        unit_price_4dp: grossFils * 100n,
        vat_category_id: vatCategoryId,
        net_fils: 0n,
        vat_fils: 0n,
        gross_fils: 0n,
      }),
    )
    .execute();
  await trx.updateTable('sales.documents').set({ notes: null }).where('id', '=', doc.id).execute();
  await issueDraft(trx, doc.id);
  return doc.id;
}

/** Receives one payment; returns it and the payment invoice its remainder created, if any. */
export async function receivePayment(
  trx: Transaction<DB>,
  body: ReceivePaymentRequest,
): Promise<ReceivePaymentResponse> {
  const customerId = BigInt(body.customerId);
  const date = body.paymentDate ?? (await today(trx));
  const amount = BigInt(body.part.amountFils);
  const payment = await insertPayment(trx, {
    kind: 'receipt',
    customerId,
    part: body.part,
    date,
    quotationId: body.quotationId ? BigInt(body.quotationId) : null,
    notes: body.notes ?? null,
  });

  let left = amount;
  if (!body.asAdvance) {
    if (body.allocations && body.allocations.length > 0) {
      for (const [i, a] of body.allocations.entries()) {
        const share = BigInt(a.amountFils);
        if (share > left) throw fieldError(`allocations.${i}.amountFils`, 'more_than_payment');
        if (!a.documentId === !a.openingBalanceId)
          throw fieldError(`allocations.${i}`, 'one_target');
        await allocate(
          trx,
          payment.id,
          a.documentId
            ? { documentId: BigInt(a.documentId) }
            : { openingBalanceId: BigInt(a.openingBalanceId!) },
          share,
        );
        left -= share;
      }
    } else {
      for (const debt of await openDebts(trx, customerId)) {
        if (left === 0n) break;
        const share = debt.left < left ? debt.left : left;
        await allocate(trx, payment.id, debt, share);
        left -= share;
      }
    }
  }

  let advanceId: bigint | null = null;
  if (left > 0n) {
    advanceId = await issueAdvanceInvoice(trx, customerId, left, {
      date,
      quotationId: body.quotationId ? BigInt(body.quotationId) : null,
      businessLineId: body.businessLineId ? BigInt(body.businessLineId) : undefined,
      vatCategoryId: body.vatCategoryId ? BigInt(body.vatCategoryId) : undefined,
    });
    await allocate(trx, payment.id, { documentId: advanceId }, left);
  }
  await postPayment(trx, payment.id);
  return {
    payment: await getPayment(trx, payment.id),
    advanceInvoice: advanceId ? await getDocument(trx, advanceId) : null,
  };
}

/** Pays money back against credit notes (or what the customer was owed at go-live). */
export async function refund(
  trx: Transaction<DB>,
  customerId: bigint,
  part: PaymentPart,
  targets: { documentId?: bigint; openingBalanceId?: bigint; amount: bigint }[],
  approvalId: bigint | null,
): Promise<bigint> {
  const date = await today(trx);
  const p = await insertPayment(trx, { kind: 'refund', customerId, part, date, approvalId });
  for (const t of targets) await allocate(trx, p.id, t, t.amount);
  await postPayment(trx, p.id);
  return p.id;
}

/**
 * Reverses a posted payment (a bounced cheque, an entry error): every document it settled is
 * open again. A payment invoice it created is reversed by a credit note in the same operation;
 * that is refused once a final invoice has deducted it.
 */
export async function reversePayment(
  trx: Transaction<DB>,
  id: bigint,
  body: ReversePaymentRequest,
  issueAdvanceCredit: (advanceId: bigint, reasonCodeId: bigint) => Promise<void>,
): Promise<PaymentDetail> {
  const original = await trx
    .selectFrom('sales.payments')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!original) throw new AppError('NOT_FOUND', 'No such payment');
  const approvalId = await useApproval(
    trx,
    body.approvalId,
    ['payments.reverse'],
    `sales.payments:${id}`,
  );
  const allocations = await trx
    .selectFrom('sales.payment_allocations as a')
    .leftJoin('sales.documents as d', 'd.id', 'a.document_id')
    .select([
      'a.document_id',
      'a.opening_balance_id',
      'a.amount_fils',
      'd.doc_type',
      'd.advance_used_net_fils',
      'd.advance_used_vat_fils',
    ])
    .where('a.payment_id', '=', id)
    .execute();
  for (const a of allocations) {
    if (
      a.doc_type === 'advance_invoice' &&
      (a.advance_used_net_fils! > 0n || a.advance_used_vat_fils! > 0n)
    ) {
      throw ruleError('ADVANCE_DEDUCTION', 'A final invoice already deducted this payment');
    }
  }
  const reversal = await insertPayment(trx, {
    kind: 'reversal',
    reversalOfId: id,
    customerId: original.customer_id,
    part: {
      paymentMethodId: original.payment_method_id.toString(),
      amountFils: original.amount_fils.toString(),
      reference: original.reference,
    },
    date: await today(trx),
    reasonCodeId: BigInt(body.reasonCodeId),
    approvalId,
    notes: body.notes ?? null,
  });
  for (const a of allocations) {
    await allocate(
      trx,
      reversal.id,
      a.document_id ? { documentId: a.document_id } : { openingBalanceId: a.opening_balance_id! },
      a.amount_fils,
    );
  }
  await postPayment(trx, reversal.id);
  for (const a of allocations) {
    if (a.doc_type === 'advance_invoice')
      await issueAdvanceCredit(a.document_id!, BigInt(body.reasonCodeId));
  }
  return getPayment(trx, reversal.id);
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

function paymentBase(db: Db) {
  return db
    .selectFrom('sales.payments as p')
    .innerJoin('md.customers as c', 'c.id', 'p.customer_id')
    .select([
      'p.id',
      'p.payment_kind',
      'p.status',
      'p.doc_number',
      'p.customer_id',
      'c.name as customer_name',
      'p.payment_method_id',
      'p.method_kind',
      'p.amount_fils',
      'p.payment_date',
      'p.reference',
      'p.reversal_of_id',
    ]);
}

type PaymentRow = Awaited<ReturnType<ReturnType<typeof paymentBase>['executeTakeFirstOrThrow']>>;

const paymentItem = (r: PaymentRow): PaymentItem => ({
  id: r.id.toString(),
  paymentKind: r.payment_kind as PaymentItem['paymentKind'],
  status: r.status as PaymentItem['status'],
  docNumber: r.doc_number,
  customerId: r.customer_id.toString(),
  customerName: r.customer_name,
  paymentMethodId: r.payment_method_id.toString(),
  methodKind: r.method_kind,
  amountFils: r.amount_fils.toString(),
  paymentDate: r.payment_date,
  reference: r.reference,
  reversalOfId: r.reversal_of_id?.toString() ?? null,
});

export async function listPayments(db: Db, query: PaymentsQuery): Promise<PaymentsResponse> {
  let q = paymentBase(db);
  if (query.kind) q = q.where('p.payment_kind', '=', query.kind);
  if (query.customerId) q = q.where('p.customer_id', '=', BigInt(query.customerId));
  if (query.from) q = q.where('p.payment_date', '>=', query.from);
  if (query.to) q = q.where('p.payment_date', '<=', query.to);
  if (query.q) {
    q = q.where((eb) =>
      eb.or([
        eb('p.doc_number', 'ilike', `%${query.q}%`),
        eb('p.reference', 'ilike', `%${query.q}%`),
        eb(
          sql<string>`c.search_key`,
          'like',
          sql<string>`'%' || sys.normalize_search(${query.q}) || '%'`,
        ),
      ]),
    );
  }
  const total = await q
    .clearSelect()
    .select(sql<number>`count(*)::int`.as('n'))
    .executeTakeFirstOrThrow();
  const rows = await q
    .orderBy('p.payment_date', 'desc')
    .orderBy('p.id', 'desc')
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .execute();
  return { total: total.n, payments: rows.map(paymentItem) };
}

export async function getPayment(db: Db, id: bigint): Promise<PaymentDetail> {
  const row = await paymentBase(db)
    .leftJoin('auth.users as u', 'u.id', 'p.created_by')
    .select([
      'p.cheque_date',
      'p.cheque_bank',
      'p.notes',
      'u.display_name_ar',
      'u.display_name_en',
      sql<string | null>`(SELECT j.id::text FROM gl.journal_entries j
                           WHERE j.source_type = 'payment' AND j.payment_id = p.id)`.as(
        'journal_id',
      ),
    ])
    .where('p.id', '=', id)
    .executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'No such payment');
  const allocations = await db
    .selectFrom('sales.payment_allocations as a')
    .leftJoin('sales.documents as d', 'd.id', 'a.document_id')
    .select([
      'a.document_id',
      'a.opening_balance_id',
      'd.doc_number',
      'd.doc_type',
      'a.amount_fils',
    ])
    .where('a.payment_id', '=', id)
    .orderBy('a.id')
    .execute();
  const advance = allocations.find(
    (a) => a.doc_type === 'advance_invoice' && row.payment_kind === 'receipt',
  );
  return {
    ...paymentItem(row),
    chequeDate: row.cheque_date,
    chequeBank: row.cheque_bank,
    notes: row.notes,
    receivedByName:
      row.display_name_ar && row.display_name_en
        ? { displayNameAr: row.display_name_ar, displayNameEn: row.display_name_en }
        : null,
    allocations: allocations.map((a) => ({
      documentId: a.document_id?.toString() ?? null,
      openingBalanceId: a.opening_balance_id?.toString() ?? null,
      docNumber: a.doc_number,
      docType: (a.doc_type ?? 'opening_balance') as DocType | 'opening_balance',
      amountFils: a.amount_fils.toString(),
    })),
    advanceDocumentId: advance?.document_id?.toString() ?? null,
    journalEntryId: row.journal_id,
  };
}
