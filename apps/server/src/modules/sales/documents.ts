/**
 * Tax documents (INV-, CN-, DN-): drafts, issue, discard and reading. Issuing is one transaction
 * (golden rule 4): the number, the stock movements and their cost, the journal entry, the outbox
 * row (by the database), any payment received at issue, and the audit. The database works out
 * every line and refuses anything the rules forbid (decisions 0009–0013, 0046).
 */
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { quantityFromDb } from '@artepool/shared';
import type {
  DocType,
  DocumentDetail,
  DocumentItem,
  DocumentsQuery,
  DocumentsResponse,
  InvoiceFormat,
  IssueRequest,
  SalesLine,
  SaveInvoiceRequest,
  SettlementStatus,
  StockStatus,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { filledByDatabase } from '../../platform/db/stamped';
import { assertVersion, expectUpdated, fieldError } from '../../platform/db/versioned';
import { AppError, ruleError } from '../../platform/errors/app-error';
import { consumeApproval } from '../approvals/service';
import { addMovement, today, warehouseOf } from '../inventory/service';
import { postEntry } from '../ledger/posting';
import { documentPosting } from '../ledger/sales-posting';
import { prepareLines, type PreparedLine } from './lines';

export type Auth = { permissions: ReadonlySet<string> } | null;
type Db = Kysely<DB> | Transaction<DB>;

// ---------------------------------------------------------------------------------------------
// Defaults and snapshots
// ---------------------------------------------------------------------------------------------

export async function defaultBusinessLine(db: Db): Promise<bigint> {
  const row = await db
    .selectFrom('md.business_lines')
    .select('id')
    .where('is_active', '=', true)
    .orderBy('sort_order')
    .orderBy('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function defaultBranch(db: Db): Promise<bigint> {
  const row = await db
    .selectFrom('sys.branches')
    .select('id')
    .orderBy('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The customer's details as printed on the document (the TRN is set by the database at issue). */
export async function billTo(db: Db, customerId: bigint) {
  const c = await db
    .selectFrom('md.customers')
    .select(['id', 'name', 'name_alt', 'phone', 'address_line', 'area', 'city', 'is_active'])
    .where('id', '=', customerId)
    .executeTakeFirst();
  if (!c || !c.is_active) throw fieldError('customerId', 'unknown');
  const address = [c.address_line, c.area, c.city].filter(Boolean).join('، ');
  return {
    bill_to_name: c.name,
    bill_to_name_alt: c.name_alt,
    bill_to_phone: c.phone,
    bill_to_address: address === '' ? null : address,
  };
}

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

/** Inserts prepared item lines (the database works out the amounts; zeros are placeholders). */
export async function insertItemLines(
  trx: Transaction<DB>,
  documentId: bigint,
  rows: PreparedLine[],
) {
  if (rows.length === 0) return;
  await trx
    .insertInto('sales.document_lines')
    .values(
      rows.map((r) =>
        filledByDatabase('sales.document_lines', {
          document_id: documentId,
          line_no: r.line_no,
          line_kind: 'item',
          item_id: r.item_id,
          description_ar: r.description_ar,
          description_en: r.description_en,
          unit_id: r.unit_id,
          business_line_id: r.business_line_id,
          quantity: r.quantity,
          unit_price_4dp: r.unit_price_4dp,
          line_discount_bp: r.line_discount_bp,
          line_discount_fils: r.line_discount_fils,
          doc_discount_alloc_fils: r.doc_discount_alloc_fils,
          note: r.note,
          quotation_line_id: r.quotation_line_id ?? null,
          vat_category_id: sql<bigint>`(SELECT vat_category_id FROM md.items WHERE id = ${r.item_id})`,
          net_fils: 0n,
          vat_fils: 0n,
          gross_fils: 0n,
        }),
      ),
    )
    .execute();
}

/** What remains of a payment invoice to deduct or credit (decision 0013). */
export async function advanceLeft(db: Db, advanceId: bigint, customerId: bigint) {
  const a = await db
    .selectFrom('sales.documents as d')
    .select([
      'd.id',
      'd.doc_number',
      'd.customer_id',
      'd.doc_type',
      'd.status',
      sql<bigint>`d.net_fils - d.advance_used_net_fils`.as('net_left'),
      sql<bigint>`d.vat_fils - d.advance_used_vat_fils`.as('vat_left'),
      sql<bigint>`(SELECT l.vat_category_id FROM sales.document_lines l WHERE l.document_id = d.id ORDER BY l.line_no LIMIT 1)`.as(
        'vat_category_id',
      ),
      sql<bigint>`(SELECT l.business_line_id FROM sales.document_lines l WHERE l.document_id = d.id ORDER BY l.line_no LIMIT 1)`.as(
        'business_line_id',
      ),
    ])
    .where('d.id', '=', advanceId)
    .executeTakeFirst();
  if (
    !a ||
    a.doc_type !== 'advance_invoice' ||
    a.status !== 'issued' ||
    a.customer_id !== customerId
  ) {
    throw ruleError('ADVANCE_DEDUCTION', 'Only an issued payment invoice of the same customer');
  }
  return { ...a, net_left: BigInt(a.net_left), vat_left: BigInt(a.vat_left) };
}

async function insertDeductions(
  trx: Transaction<DB>,
  documentId: bigint,
  customerId: bigint,
  advances: bigint[],
  firstLineNo: number,
) {
  let lineNo = firstLineNo;
  for (const advanceId of advances) {
    const a = await advanceLeft(trx, advanceId, customerId);
    if (a.net_left <= 0n && a.vat_left <= 0n) continue;
    const gross = a.net_left + a.vat_left;
    await trx
      .insertInto('sales.document_lines')
      .values(
        filledByDatabase('sales.document_lines', {
          document_id: documentId,
          line_no: lineNo++,
          line_kind: 'advance_deduction',
          description_ar: `يُخصم: دفعة ${a.doc_number}`,
          description_en: `Less: payment ${a.doc_number}`,
          business_line_id: BigInt(a.business_line_id),
          quantity: '1.000',
          unit_price_4dp: -gross * 100n,
          vat_category_id: BigInt(a.vat_category_id),
          net_fils: -a.net_left,
          vat_fils: -a.vat_left,
          gross_fils: -gross,
          advance_document_id: a.id,
        }),
      )
      .execute();
  }
}

// ---------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------

/** Creates or replaces an invoice draft. Returns its id. */
export async function saveInvoiceDraft(
  trx: Transaction<DB>,
  id: bigint | null,
  body: SaveInvoiceRequest,
): Promise<bigint> {
  const customerId = BigInt(body.customerId);
  const businessLineId = body.businessLineId
    ? BigInt(body.businessLineId)
    : await defaultBusinessLine(trx);
  const header = {
    customer_id: customerId,
    business_line_id: businessLineId,
    ...(await billTo(trx, customerId)),
    issue_date: body.issueDate ?? null,
    supply_date: body.supplyDate ?? null,
    due_date: body.dueDate ?? null,
    customer_po: body.customerPo ?? null,
    notes: body.notes ?? null,
    internal_note: body.internalNote ?? null,
    doc_discount_fils: BigInt(body.docDiscountFils ?? '0'),
  };
  let documentId: bigint;
  let quotationId: bigint | null = body.quotationId ? BigInt(body.quotationId) : null;
  if (id === null) {
    const row = await trx
      .insertInto('sales.documents')
      .values(
        filledByDatabase('sales.documents', {
          doc_type: 'invoice',
          channel: 'office',
          branch_id: await defaultBranch(trx),
          warehouse_id: await warehouseOf(trx, undefined),
          device_id: sql<bigint>`sys.ctx_device_id()`,
          quotation_id: body.quotationId ? BigInt(body.quotationId) : null,
          ...header,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    documentId = row.id;
  } else {
    const current = await trx
      .selectFrom('sales.documents')
      .select(['status', 'doc_type', 'quotation_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!current) throw new AppError('NOT_FOUND', 'No such document');
    quotationId = current.quotation_id;
    if (current.status !== 'draft' || current.doc_type !== 'invoice') {
      throw ruleError('DOCUMENT_STEP', 'Only a draft invoice changes');
    }
    if (body.rowVersion === undefined) throw fieldError('rowVersion', 'required');
    await expectUpdated(
      trx,
      'sales.documents',
      id,
      await trx
        .updateTable('sales.documents')
        .set(header)
        .where('id', '=', id)
        .where('row_version', '=', body.rowVersion)
        .executeTakeFirst(),
    );
    await trx.deleteFrom('sales.document_lines').where('document_id', '=', id).execute();
    documentId = id;
  }
  const rows = await prepareLines(trx, {
    lines: body.lines,
    docDiscountFils: header.doc_discount_fils,
    businessLineId,
    priceLevelId: null,
    quotationId,
  });
  await insertItemLines(trx, documentId, rows);
  await insertDeductions(
    trx,
    documentId,
    customerId,
    (body.deductions ?? []).map((d) => BigInt(d.advanceDocumentId)),
    rows.length + 1,
  );
  await touch(trx, documentId);
  return documentId;
}

/** A header update after line changes, so the draft's totals follow its lines. */
export async function touch(trx: Transaction<DB>, documentId: bigint) {
  await trx
    .updateTable('sales.documents')
    .set({ doc_discount_fils: sql<bigint>`doc_discount_fils` })
    .where('id', '=', documentId)
    .execute();
}

export async function discardDocument(trx: Transaction<DB>, id: bigint, rowVersion: number) {
  await expectUpdated(
    trx,
    'sales.documents',
    id,
    await trx
      .updateTable('sales.documents')
      .set({ status: 'discarded' })
      .where('id', '=', id)
      .where('status', '=', 'draft')
      .where('row_version', '=', rowVersion)
      .executeTakeFirst(),
  );
}

// ---------------------------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------------------------

const APPROVABLE_ON_DOCUMENT = [
  'sales.discount_over_limit',
  'sales.price_override',
  'credit_notes.issue',
];

/** Uses a supervisor's approval for this document, if it is for one of the given permissions. */
export async function useApproval(
  trx: Transaction<DB>,
  approvalId: string | undefined,
  allowed: string[],
  entity: string,
): Promise<bigint | null> {
  if (!approvalId) return null;
  const a = await trx
    .selectFrom('auth.approvals')
    .select('permission_code')
    .where('id', '=', BigInt(approvalId))
    .executeTakeFirst();
  if (!a || !allowed.includes(a.permission_code)) {
    throw new AppError('APPROVAL_INVALID', 'This approval is for something else');
  }
  await consumeApproval(trx, BigInt(approvalId), a.permission_code, entity);
  return BigInt(approvalId);
}

/** The sale movements of every stock line (and every stock component of a kit), then its cost. */
async function moveStock(trx: Transaction<DB>, documentId: bigint, date: string) {
  const lines = await trx
    .selectFrom('sales.document_lines as l')
    .innerJoin('sales.documents as d', 'd.id', 'l.document_id')
    .innerJoin('md.items as i', 'i.id', 'l.item_id')
    .select(['l.id', 'l.item_id', 'l.quantity', 'i.item_type', 'd.warehouse_id'])
    .where('l.document_id', '=', documentId)
    .where('l.line_kind', '=', 'item')
    .where('i.item_type', 'in', ['stock', 'bundle'])
    .orderBy('l.line_no')
    .execute();
  for (const l of lines) {
    const qty = quantityFromDb(l.quantity);
    const parts =
      l.item_type === 'stock'
        ? [{ itemId: l.item_id!, milli: qty }]
        : (
            await trx
              .selectFrom('md.bundle_components as c')
              .innerJoin('md.items as ci', 'ci.id', 'c.component_item_id')
              .select(['c.component_item_id', 'c.quantity'])
              .where('c.bundle_item_id', '=', l.item_id!)
              .where('ci.item_type', '=', 'stock')
              .execute()
          ).map((c) => ({
            itemId: c.component_item_id,
            milli: (qty * quantityFromDb(c.quantity)) / 1000n,
          }));
    let cost = 0n;
    for (const p of parts) {
      const m = await addMovement(trx, {
        type: 'sale',
        date,
        itemId: p.itemId,
        warehouseId: l.warehouse_id,
        status: 'available',
        quantityMilli: -p.milli,
        salesDocumentLineId: l.id,
      });
      cost += m.valueFils < 0n ? -m.valueFils : m.valueFils;
    }
    await trx
      .updateTable('sales.document_lines')
      .set({ cost_fils: cost })
      .where('id', '=', l.id)
      .execute();
  }
}

/** SHA-256 of the document's canonical content at issue (what was agreed, line by line). */
async function contentHash(db: Db, documentId: bigint, date: string): Promise<Buffer> {
  const d = await db
    .selectFrom('sales.documents')
    .select(['doc_type', 'customer_id', 'uuid', 'doc_discount_fils'])
    .where('id', '=', documentId)
    .executeTakeFirstOrThrow();
  const lines = await db
    .selectFrom('sales.document_lines')
    .select([
      'line_no',
      'line_kind',
      'item_id',
      'description_ar',
      'description_en',
      'quantity',
      'unit_price_4dp',
      'line_discount_fils',
      'doc_discount_alloc_fils',
      'net_fils',
      'vat_rate_bp',
      'vat_fils',
      'gross_fils',
      'advance_document_id',
      'original_line_id',
    ])
    .where('document_id', '=', documentId)
    .orderBy('line_no')
    .execute();
  const canonical = JSON.stringify({ ...d, date, lines }, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  return createHash('sha256').update(canonical).digest();
}

/** The journal entry of an issued document (posting map rows 1, 2, 4, 6–9). */
export async function postDocument(trx: Transaction<DB>, documentId: bigint) {
  const d = await trx
    .selectFrom('sales.documents')
    .select(['doc_type', 'customer_id', 'total_fils', 'vat_fils', 'issue_date', 'doc_number'])
    .where('id', '=', documentId)
    .executeTakeFirstOrThrow();
  const lines = await trx
    .selectFrom('sales.document_lines as l')
    .innerJoin('md.business_lines as b', 'b.id', 'l.business_line_id')
    .select([
      'l.line_kind',
      'l.net_fils',
      'l.cost_fils',
      'l.return_stock_status',
      'l.business_line_id',
      'b.revenue_account_id',
      'b.cogs_account_id',
    ])
    .where('l.document_id', '=', documentId)
    .execute();
  await postEntry(trx, {
    date: d.issue_date!,
    source: { type: 'sales_document', id: documentId },
    memo: d.doc_number ?? undefined,
    amounts: documentPosting({
      docType: d.doc_type as DocType,
      customerId: d.customer_id,
      totalFils: d.total_fils,
      vatFils: d.vat_fils,
      lines: lines.map((l) => ({
        kind: l.line_kind as 'item' | 'advance' | 'advance_deduction',
        netFils: l.net_fils,
        businessLineId: l.business_line_id,
        revenueAccountId: l.revenue_account_id,
        cogsAccountId: l.cogs_account_id,
        costFils: l.cost_fils,
        returnStockStatus: l.return_stock_status as StockStatus | null,
      })),
    }),
  });
}

/**
 * Issues a draft: approvals, stock and cost, the number and frozen content (database), the journal
 * entry. Returns the issue date. Payments at issue are received by the caller afterwards.
 */
export async function issueDraft(
  trx: Transaction<DB>,
  id: bigint,
  opts: {
    rowVersion?: number;
    approvalId?: string;
    priceApprovalId?: string;
    creditApprovalId?: string;
  } = {},
): Promise<string> {
  const d = await trx
    .selectFrom('sales.documents')
    .select(['status', 'issue_date', 'doc_type'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!d) throw new AppError('NOT_FOUND', 'No such document');
  if (d.status !== 'draft') throw ruleError('DOCUMENT_STEP', 'The document is not a draft');
  if (opts.rowVersion !== undefined)
    await assertVersion(trx, 'sales.documents', id, opts.rowVersion);
  const date = d.issue_date ?? (await today(trx));
  const approvalId = await useApproval(
    trx,
    opts.approvalId,
    APPROVABLE_ON_DOCUMENT,
    `sales.documents:${id}`,
  );
  const priceApprovalId = await useApproval(
    trx,
    opts.priceApprovalId,
    ['sales.price_override'],
    `sales.documents:${id}:price`,
  );
  if (priceApprovalId !== null) {
    // A price approval covers the lines whose price differs from the item's (decision 0012).
    await trx
      .updateTable('sales.document_lines')
      .set({ price_override_approval_id: priceApprovalId })
      .where('document_id', '=', id)
      .where('line_kind', '=', 'item')
      .where(sql<boolean>`unit_price_4dp <> list_price_4dp`)
      .execute();
  }
  if (approvalId !== null) {
    // (Older screens sent a price approval here: it still covers the prices, never the discount.)
    await trx
      .updateTable('sales.document_lines')
      .set({ price_override_approval_id: approvalId })
      .where('document_id', '=', id)
      .where('line_kind', '=', 'item')
      .where(sql<boolean>`unit_price_4dp <> list_price_4dp`)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('auth.approvals')
            .select('id')
            .where('id', '=', approvalId)
            .where('permission_code', '=', 'sales.price_override'),
        ),
      )
      .execute();
  }
  const creditApprovalId = await useApproval(
    trx,
    opts.creditApprovalId,
    ['sales.credit_over_limit'],
    `sales.documents:${id}:credit`,
  );
  if (d.doc_type === 'invoice') await moveStock(trx, id, date);
  await trx
    .updateTable('sales.documents')
    .set({
      status: 'issued',
      issue_date: date,
      approval_id: approvalId,
      credit_approval_id: creditApprovalId,
      content_hash: await contentHash(trx, id, date),
    })
    .where('id', '=', id)
    .execute();
  await postDocument(trx, id);
  return date;
}

export async function issueInvoice(
  trx: Transaction<DB>,
  id: bigint,
  body: IssueRequest,
  receive: (
    documentId: bigint,
    customerId: bigint,
    parts: NonNullable<IssueRequest['payments']>,
  ) => Promise<void>,
): Promise<void> {
  await issueDraft(trx, id, body);
  if (body.payments && body.payments.length > 0) {
    const d = await trx
      .selectFrom('sales.documents')
      .select(['customer_id', 'total_fils', 'settled_fils'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const paying = body.payments.reduce((s, p) => s + BigInt(p.amountFils), 0n);
    if (paying > d.total_fils - d.settled_fils) throw fieldError('payments', 'more_than_due');
    await receive(id, d.customer_id, body.payments);
  }
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

function documentBase(db: Db) {
  return db
    .selectFrom('sales.documents as d')
    .innerJoin('md.customers as c', 'c.id', 'd.customer_id')
    .leftJoin('sales.documents as o', 'o.id', 'd.original_document_id')
    .select([
      'd.id',
      'd.doc_type',
      'd.invoice_format',
      'd.status',
      'd.doc_number',
      'd.channel',
      'd.customer_id',
      'c.name as customer_name',
      'd.issue_date',
      'd.due_date',
      'd.discount_total_fils',
      'd.net_fils',
      'd.vat_fils',
      'd.total_fils',
      'd.settled_fils',
      'd.settlement_status',
      'd.advance_used_net_fils',
      'd.advance_used_vat_fils',
      'd.original_document_id',
      'o.doc_number as original_number',
      'd.quotation_id',
      'd.print_count',
      'd.row_version',
    ]);
}

type DocumentRow = Awaited<ReturnType<ReturnType<typeof documentBase>['executeTakeFirstOrThrow']>>;

function documentItem(r: DocumentRow): DocumentItem {
  return {
    id: r.id.toString(),
    docType: r.doc_type as DocType,
    invoiceFormat: r.invoice_format as InvoiceFormat,
    status: r.status as DocumentItem['status'],
    docNumber: r.doc_number,
    channel: r.channel as 'pos' | 'office',
    customerId: r.customer_id.toString(),
    customerName: r.customer_name,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    discountTotalFils: r.discount_total_fils.toString(),
    netFils: r.net_fils.toString(),
    vatFils: r.vat_fils.toString(),
    totalFils: r.total_fils.toString(),
    settledFils: r.settled_fils.toString(),
    settlementStatus: r.settlement_status as SettlementStatus,
    ...(r.doc_type === 'advance_invoice'
      ? {
          advanceLeftNetFils: (r.net_fils - r.advance_used_net_fils).toString(),
          advanceLeftVatFils: (r.vat_fils - r.advance_used_vat_fils).toString(),
        }
      : {}),
    originalDocumentId: r.original_document_id?.toString() ?? null,
    originalDocumentNumber: r.original_number,
    quotationId: r.quotation_id?.toString() ?? null,
    printCount: r.print_count,
    rowVersion: r.row_version,
  };
}

export async function listDocuments(db: Db, query: DocumentsQuery): Promise<DocumentsResponse> {
  let q = documentBase(db);
  if (query.docType) q = q.where('d.doc_type', '=', query.docType);
  if (query.status) q = q.where('d.status', '=', query.status);
  else q = q.where('d.status', '<>', 'discarded');
  if (query.settlement === 'unpaid') q = q.where('d.settlement_status', '<>', 'settled');
  else if (query.settlement) q = q.where('d.settlement_status', '=', query.settlement);
  if (query.customerId) q = q.where('d.customer_id', '=', BigInt(query.customerId));
  if (query.from) q = q.where('d.issue_date', '>=', query.from);
  if (query.to) q = q.where('d.issue_date', '<=', query.to);
  if (query.q) {
    const text = `%${query.q}%`;
    q = q.where((eb) =>
      eb.or([
        eb('d.doc_number', 'ilike', text),
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
    .orderBy(sql`d.issue_date DESC NULLS FIRST`)
    .orderBy('d.id', 'desc')
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .execute();
  return { total: total.n, documents: rows.map(documentItem) };
}

export async function documentLines(db: Db, documentId: bigint): Promise<SalesLine[]> {
  const rows = await db
    .selectFrom('sales.document_lines as l')
    .leftJoin('md.items as i', 'i.id', 'l.item_id')
    .leftJoin('sales.documents as a', 'a.id', 'l.advance_document_id')
    .selectAll('l')
    .select([
      'i.code as item_code',
      'a.doc_number as advance_number',
      sql<string>`(SELECT coalesce(sum(x.quantity), 0)::text FROM sales.document_lines x
                     JOIN sales.documents xd ON xd.id = x.document_id
                    WHERE x.original_line_id = l.id AND xd.status = 'issued' AND xd.doc_type = 'credit_note')`.as(
        'credited',
      ),
    ])
    .where('l.document_id', '=', documentId)
    .orderBy('l.line_no')
    .execute();
  return rows.map((l) => ({
    id: l.id.toString(),
    lineNo: l.line_no,
    lineKind: l.line_kind as SalesLine['lineKind'],
    itemId: l.item_id?.toString() ?? null,
    itemCode: l.item_code,
    descriptionAr: l.description_ar,
    descriptionEn: l.description_en,
    unitId: l.unit_id?.toString() ?? null,
    businessLineId: l.business_line_id.toString(),
    quantityMilli: quantityFromDb(l.quantity).toString(),
    listPrice4dp: l.list_price_4dp.toString(),
    unitPrice4dp: l.unit_price_4dp.toString(),
    priceIncludesVat: l.price_includes_vat,
    amountBeforeDiscountFils: l.amount_before_discount_fils.toString(),
    lineDiscountFils: l.line_discount_fils.toString(),
    lineDiscountBp: l.line_discount_bp,
    docDiscountAllocFils: l.doc_discount_alloc_fils.toString(),
    discountExclVatFils: l.discount_excl_vat_fils.toString(),
    netFils: l.net_fils.toString(),
    vatCategoryId: l.vat_category_id.toString(),
    vatRateBp: l.vat_rate_bp,
    vatFils: l.vat_fils.toString(),
    grossFils: l.gross_fils.toString(),
    advanceDocumentId: l.advance_document_id?.toString() ?? null,
    advanceDocumentNumber: l.advance_number,
    quotationLineId: l.quotation_line_id?.toString() ?? null,
    originalLineId: l.original_line_id?.toString() ?? null,
    returnStockStatus: l.return_stock_status as StockStatus | null,
    creditedMilli: quantityFromDb(l.credited).toString(),
    note: l.note,
  }));
}

export async function getDocument(db: Db, id: bigint): Promise<DocumentDetail> {
  const row = await documentBase(db)
    .leftJoin('auth.users as u', 'u.id', 'd.issued_by')
    .select([
      'd.business_line_id',
      'd.bill_to_name',
      'd.bill_to_name_alt',
      'd.bill_to_trn',
      'd.bill_to_address',
      'd.bill_to_phone',
      'd.supply_date',
      'd.issued_at',
      'd.doc_discount_fils',
      'd.reason_code_id',
      'd.reason_text',
      'd.customer_po',
      'd.notes',
      'd.internal_note',
      'u.display_name_ar as issued_ar',
      'u.display_name_en as issued_en',
      sql<string | null>`(SELECT j.id::text FROM gl.journal_entries j
                           WHERE j.source_type = 'sales_document' AND j.sales_document_id = d.id)`.as(
        'journal_id',
      ),
    ])
    .where('d.id', '=', id)
    .executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'No such document');
  const payments = await db
    .selectFrom('sales.payment_allocations as a')
    .innerJoin('sales.payments as p', 'p.id', 'a.payment_id')
    .select(['p.id', 'p.doc_number', 'p.payment_date', 'p.payment_kind', 'a.amount_fils'])
    .where('a.document_id', '=', id)
    .orderBy('p.id')
    .execute();
  const credits = await db
    .selectFrom('sales.credit_allocations as a')
    .innerJoin('sales.documents as n', 'n.id', 'a.credit_note_id')
    .select(['n.id', 'n.doc_number', 'n.issue_date', 'a.amount_fils'])
    .where('a.invoice_id', '=', id)
    .orderBy('n.id')
    .execute();
  const detail: DocumentDetail = {
    ...documentItem(row),
    businessLineId: row.business_line_id.toString(),
    billToName: row.bill_to_name,
    billToNameAlt: row.bill_to_name_alt,
    billToTrn: row.bill_to_trn,
    billToAddress: row.bill_to_address,
    billToPhone: row.bill_to_phone,
    supplyDate: row.supply_date,
    issuedAt: row.issued_at?.toISOString() ?? null,
    issuedByName:
      row.issued_ar && row.issued_en
        ? { displayNameAr: row.issued_ar, displayNameEn: row.issued_en }
        : null,
    docDiscountFils: row.doc_discount_fils.toString(),
    reasonCodeId: row.reason_code_id?.toString() ?? null,
    reasonText: row.reason_text,
    customerPo: row.customer_po,
    notes: row.notes,
    internalNote: row.internal_note,
    journalEntryId: row.journal_id,
    lines: await documentLines(db, id),
    settlements: [
      ...payments.map((p) => ({
        kind: 'payment' as const,
        id: p.id.toString(),
        docNumber: p.doc_number,
        date: p.payment_date,
        amountFils: (p.payment_kind === 'reversal' ? -p.amount_fils : p.amount_fils).toString(),
      })),
      ...credits.map((c) => ({
        kind: 'credit_note' as const,
        id: c.id.toString(),
        docNumber: c.doc_number ?? '',
        date: c.issue_date ?? '',
        amountFils: c.amount_fils.toString(),
      })),
    ],
  };
  if (row.status === 'draft' && row.doc_type === 'invoice') {
    detail.deductible = (
      await listDocuments(db, {
        docType: 'advance_invoice',
        status: 'issued',
        customerId: row.customer_id.toString(),
        page: 1,
        pageSize: 200,
      })
    ).documents.filter(
      (a) => BigInt(a.advanceLeftNetFils ?? '0') > 0n || BigInt(a.advanceLeftVatFils ?? '0') > 0n,
    );
  }
  return detail;
}

/** Counts a print or reprint (reprints are marked "Copy", decision 0008). */
export async function countPrint(trx: Transaction<DB>, id: bigint): Promise<number> {
  const row = await trx
    .updateTable('sales.documents')
    .set({ print_count: sql<number>`print_count + 1` })
    .where('id', '=', id)
    .where('status', '=', 'issued')
    .returning('print_count')
    .executeTakeFirst();
  if (!row) throw ruleError('DOCUMENT_STEP', 'Only an issued document is printed');
  return row.print_count;
}
