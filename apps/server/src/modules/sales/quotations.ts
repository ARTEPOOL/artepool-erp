/**
 * Quotations (Q-): numbered at first save, edited while draft, sent (prices approved then), then
 * accepted, rejected or expired. A sent quotation changes only through a new revision with the
 * same number. Converting makes an invoice draft at the quotation's prices (decision 0049).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { quantityFromDb } from '@artepool/shared';
import type {
  QuotationActionRequest,
  QuotationDetail,
  QuotationItem,
  QuotationsQuery,
  QuotationsResponse,
  QuotationStatus,
  SalesLine,
  SaveQuotationRequest,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { filledByDatabase } from '../../platform/db/stamped';
import { expectUpdated, fieldError } from '../../platform/db/versioned';
import { AppError, ruleError } from '../../platform/errors/app-error';
import { today } from '../inventory/service';
import {
  billTo,
  defaultBranch,
  defaultBusinessLine,
  insertItemLines,
  touch,
  useApproval,
} from './documents';
import { prepareLines } from './lines';

type Db = Kysely<DB> | Transaction<DB>;

async function validDays(db: Db): Promise<number> {
  const row = await db
    .selectFrom('sys.settings')
    .select(sql<number>`(value #>> '{}')::int`.as('days'))
    .where('key', '=', 'sales.quotation_valid_days')
    .executeTakeFirst();
  return row?.days ?? 15;
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function writeLines(
  trx: Transaction<DB>,
  quotationId: bigint,
  body: SaveQuotationRequest,
  businessLineId: bigint,
) {
  const rows = await prepareLines(trx, {
    lines: body.lines,
    docDiscountFils: BigInt(body.docDiscountFils ?? '0'),
    businessLineId,
    priceLevelId: null,
  });
  await trx
    .insertInto('sales.quotation_lines')
    .values(
      rows.map((r) =>
        filledByDatabase('sales.quotation_lines', {
          quotation_id: quotationId,
          line_no: r.line_no,
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
          is_optional: r.is_optional,
          note: r.note,
        }),
      ),
    )
    .execute();
}

/** Creates (id null), replaces a draft, or starts a revision of a sent quotation (revise). */
export async function saveQuotation(
  trx: Transaction<DB>,
  id: bigint | null,
  body: SaveQuotationRequest,
  opts: { revise?: boolean } = {},
): Promise<bigint> {
  const customerId = BigInt(body.customerId);
  const businessLineId = body.businessLineId
    ? BigInt(body.businessLineId)
    : await defaultBusinessLine(trx);
  const date = body.quotationDate ?? (await today(trx));
  const header = {
    business_line_id: businessLineId,
    customer_id: customerId,
    ...(await billTo(trx, customerId)),
    quotation_date: date,
    valid_until: body.validUntil ?? addDays(date, await validDays(trx)),
    subject: body.subject ?? null,
    terms_ar: body.termsAr ?? null,
    terms_en: body.termsEn ?? null,
    notes: body.notes ?? null,
    doc_discount_fils: BigInt(body.docDiscountFils ?? '0'),
  };
  let quotationId: bigint;
  if (id === null || opts.revise) {
    const row = await trx
      .insertInto('sales.quotations')
      .values(
        filledByDatabase('sales.quotations', {
          ...header,
          branch_id: await defaultBranch(trx),
          price_level_id: sql<bigint>`(SELECT id FROM md.price_levels WHERE is_default)`,
          revised_from_id: opts.revise ? id : null,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    quotationId = row.id;
  } else {
    if (body.rowVersion === undefined) throw fieldError('rowVersion', 'required');
    const current = await trx
      .selectFrom('sales.quotations')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!current) throw new AppError('NOT_FOUND', 'No such quotation');
    if (current.status !== 'draft')
      throw ruleError('DOCUMENT_STEP', 'Only a draft quotation changes');
    await expectUpdated(
      trx,
      'sales.quotations',
      id,
      await trx
        .updateTable('sales.quotations')
        .set(header)
        .where('id', '=', id)
        .where('row_version', '=', body.rowVersion)
        .executeTakeFirst(),
    );
    await trx.deleteFrom('sales.quotation_lines').where('quotation_id', '=', id).execute();
    quotationId = id;
  }
  await writeLines(trx, quotationId, body, businessLineId);
  await trx
    .updateTable('sales.quotations')
    .set({ doc_discount_fils: sql<bigint>`doc_discount_fils` })
    .where('id', '=', quotationId)
    .execute();
  return quotationId;
}

const NEXT_STATUS: Record<QuotationActionRequest['action'], QuotationStatus> = {
  send: 'sent',
  accept: 'accepted',
  reject: 'rejected',
  cancel: 'cancelled',
  expire: 'expired',
};

export async function quotationAction(
  trx: Transaction<DB>,
  id: bigint,
  body: QuotationActionRequest & { approvalId?: string },
) {
  const approvalId =
    body.action === 'send'
      ? await useApproval(
          trx,
          body.approvalId,
          ['sales.discount_over_limit', 'sales.price_override'],
          `sales.quotations:${id}`,
        )
      : null;
  await expectUpdated(
    trx,
    'sales.quotations',
    id,
    await trx
      .updateTable('sales.quotations')
      .set({ status: NEXT_STATUS[body.action], ...(approvalId ? { approval_id: approvalId } : {}) })
      .where('id', '=', id)
      .where('row_version', '=', body.rowVersion)
      .executeTakeFirst(),
  );
}

/** An invoice draft with the quotation's lines and agreed prices; the quotation is converted. */
export async function convertQuotation(
  trx: Transaction<DB>,
  id: bigint,
  rowVersion: number,
): Promise<bigint> {
  const q = await trx
    .selectFrom('sales.quotations')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!q) throw new AppError('NOT_FOUND', 'No such quotation');
  if (q.row_version !== rowVersion) {
    throw new AppError('STALE_VERSION', 'The quotation was changed by someone else', {
      currentVersion: q.row_version,
    });
  }
  if (q.status === 'sent') {
    await trx
      .updateTable('sales.quotations')
      .set({ status: 'accepted' })
      .where('id', '=', id)
      .execute();
  } else if (q.status !== 'accepted') {
    throw ruleError('DOCUMENT_STEP', 'Only a sent or accepted quotation is converted');
  }
  const doc = await trx
    .insertInto('sales.documents')
    .values(
      filledByDatabase('sales.documents', {
        doc_type: 'invoice',
        channel: 'office',
        branch_id: q.branch_id,
        business_line_id: q.business_line_id,
        warehouse_id: sql<bigint>`(SELECT id FROM md.warehouses WHERE is_default AND is_active LIMIT 1)`,
        device_id: sql<bigint>`sys.ctx_device_id()`,
        customer_id: q.customer_id,
        ...(await billTo(trx, q.customer_id)),
        quotation_id: q.id,
        notes: q.notes,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  const lines = await trx
    .selectFrom('sales.quotation_lines')
    .selectAll()
    .where('quotation_id', '=', id)
    .where('is_optional', '=', false)
    .orderBy('line_no')
    .execute();
  await insertItemLines(
    trx,
    doc.id,
    lines.map((l, i) => ({
      line_no: i + 1,
      item_id: l.item_id,
      description_ar: l.description_ar,
      description_en: l.description_en,
      unit_id: l.unit_id,
      business_line_id: l.business_line_id,
      quantity: l.quantity,
      unit_price_4dp: l.unit_price_4dp,
      line_discount_bp: l.line_discount_bp,
      line_discount_fils: l.line_discount_fils,
      doc_discount_alloc_fils: l.doc_discount_alloc_fils,
      is_optional: false,
      note: l.note,
      quotation_line_id: l.id,
    })),
  );
  await touch(trx, doc.id);
  await trx
    .updateTable('sales.quotations')
    .set({ status: 'converted', converted_document_id: doc.id })
    .where('id', '=', id)
    .execute();
  return doc.id;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

function quotationBase(db: Db) {
  return db
    .selectFrom('sales.quotations as q')
    .innerJoin('md.customers as c', 'c.id', 'q.customer_id')
    .select([
      'q.id',
      'q.doc_number',
      'q.revision',
      'q.status',
      'q.customer_id',
      'c.name as customer_name',
      'q.quotation_date',
      'q.valid_until',
      'q.subject',
      'q.converted_document_id',
      'q.discount_total_fils',
      'q.net_fils',
      'q.vat_fils',
      'q.total_fils',
      'q.row_version',
    ]);
}

type QuotationRow = Awaited<
  ReturnType<ReturnType<typeof quotationBase>['executeTakeFirstOrThrow']>
>;

const quotationItem = (r: QuotationRow): QuotationItem => ({
  id: r.id.toString(),
  docNumber: r.doc_number,
  revision: r.revision,
  status: r.status as QuotationStatus,
  customerId: r.customer_id.toString(),
  customerName: r.customer_name,
  quotationDate: r.quotation_date,
  validUntil: r.valid_until,
  subject: r.subject,
  convertedDocumentId: r.converted_document_id?.toString() ?? null,
  discountTotalFils: r.discount_total_fils.toString(),
  netFils: r.net_fils.toString(),
  vatFils: r.vat_fils.toString(),
  totalFils: r.total_fils.toString(),
  rowVersion: r.row_version,
});

export async function listQuotations(db: Db, query: QuotationsQuery): Promise<QuotationsResponse> {
  let q = quotationBase(db);
  if (query.status) q = q.where('q.status', '=', query.status);
  else q = q.where('q.status', 'not in', ['superseded']);
  if (query.customerId) q = q.where('q.customer_id', '=', BigInt(query.customerId));
  if (query.q) {
    q = q.where((eb) =>
      eb.or([
        eb('q.doc_number', 'ilike', `%${query.q}%`),
        eb('q.subject', 'ilike', `%${query.q}%`),
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
    .orderBy('q.quotation_date', 'desc')
    .orderBy('q.id', 'desc')
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .execute();
  return { total: total.n, quotations: rows.map(quotationItem) };
}

export async function getQuotation(db: Db, id: bigint): Promise<QuotationDetail> {
  const row = await quotationBase(db)
    .select([
      'q.business_line_id',
      'q.bill_to_name',
      'q.bill_to_trn',
      'q.terms_ar',
      'q.terms_en',
      'q.notes',
      'q.doc_discount_fils',
      'q.revised_from_id',
      'q.seq_no',
      'q.series_id',
    ])
    .where('q.id', '=', id)
    .executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'No such quotation');
  const revisions = await db
    .selectFrom('sales.quotations')
    .select(['id', 'revision', 'status'])
    .where('series_id', '=', row.series_id)
    .where('seq_no', '=', row.seq_no)
    .orderBy('revision')
    .execute();
  const paid = await db
    .selectFrom('sales.payments')
    .select(sql<string>`coalesce(sum(amount_fils), 0)::text`.as('n'))
    .where(
      'quotation_id',
      'in',
      revisions.map((r) => r.id),
    )
    .where('status', '=', 'posted')
    .executeTakeFirstOrThrow();
  const lines = await db
    .selectFrom('sales.quotation_lines as l')
    .innerJoin('md.items as i', 'i.id', 'l.item_id')
    .selectAll('l')
    .select('i.code as item_code')
    .where('l.quotation_id', '=', id)
    .orderBy('l.line_no')
    .execute();
  return {
    ...quotationItem(row),
    businessLineId: row.business_line_id.toString(),
    billToName: row.bill_to_name,
    billToTrn: row.bill_to_trn,
    termsAr: row.terms_ar,
    termsEn: row.terms_en,
    notes: row.notes,
    docDiscountFils: row.doc_discount_fils.toString(),
    revisedFromId: row.revised_from_id?.toString() ?? null,
    revisions: revisions.map((r) => ({
      id: r.id.toString(),
      revision: r.revision,
      status: r.status as QuotationStatus,
    })),
    paymentsFils: paid.n,
    lines: lines.map((l): SalesLine => ({
      id: l.id.toString(),
      lineNo: l.line_no,
      lineKind: 'item',
      itemId: l.item_id.toString(),
      itemCode: l.item_code,
      descriptionAr: l.description_ar,
      descriptionEn: l.description_en,
      unitId: l.unit_id.toString(),
      businessLineId: l.business_line_id.toString(),
      quantityMilli: quantityFromDb(l.quantity).toString(),
      listPrice4dp: l.list_price_4dp.toString(),
      unitPrice4dp: l.unit_price_4dp.toString(),
      priceIncludesVat: l.price_includes_vat,
      amountBeforeDiscountFils: l.amount_before_discount_fils.toString(),
      lineDiscountFils: l.line_discount_fils.toString(),
      docDiscountAllocFils: l.doc_discount_alloc_fils.toString(),
      discountExclVatFils: l.discount_excl_vat_fils.toString(),
      netFils: l.net_fils.toString(),
      vatCategoryId: l.vat_category_id.toString(),
      vatRateBp: l.vat_rate_bp,
      vatFils: l.vat_fils.toString(),
      grossFils: l.gross_fils.toString(),
      isOptional: l.is_optional,
      note: l.note,
    })),
  };
}
