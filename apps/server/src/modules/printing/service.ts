/**
 * What each printed document shows (decision 0050: the default template version stored on the
 * document, so a reprint looks like the original). Issued documents print the seller details
 * frozen at issue; a reprint is marked "Copy" (decision 0008, setting print.mark_reprints_as_copy).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../platform/db/schema.generated';
import { ruleError } from '../../platform/errors/app-error';
import { getDocument } from '../sales/documents';
import { getPayment } from '../sales/payments';
import { getQuotation } from '../sales/quotations';
import { statement } from '../sales/statement';
import {
  date,
  money,
  renderHtml,
  type PrintDocument,
  type Seller,
  type TemplateSettings,
} from './templates';

type Db = Kysely<DB> | Transaction<DB>;

async function company(db: Db): Promise<{ seller: Seller; logo: string | null }> {
  const c = await db
    .selectFrom('sys.company_profile')
    .selectAll()
    .where('id', '=', 1)
    .executeTakeFirst();
  if (!c) throw ruleError('COMPANY_MISSING', 'Fill in the company details first');
  return {
    seller: c,
    logo:
      c.logo && c.logo_mime
        ? `data:${c.logo_mime};base64,${Buffer.from(c.logo).toString('base64')}`
        : null,
  };
}

async function settingsOf(
  db: Db,
  versionId: bigint | null,
  kind: string,
): Promise<TemplateSettings> {
  const row = versionId
    ? await db
        .selectFrom('sys.print_template_versions')
        .select('settings')
        .where('id', '=', versionId)
        .executeTakeFirst()
    : await db
        .selectFrom('sys.print_templates as t')
        .innerJoin('sys.print_template_versions as v', 'v.id', 't.current_version_id')
        .select('v.settings')
        .where('t.doc_kind', '=', kind)
        .executeTakeFirst();
  return (row?.settings ?? {}) as TemplateSettings;
}

async function markCopies(db: Db): Promise<boolean> {
  const row = await db
    .selectFrom('sys.settings')
    .select(sql<boolean>`coalesce((value #>> '{}')::boolean, true)`.as('on'))
    .where('key', '=', 'print.mark_reprints_as_copy')
    .executeTakeFirst();
  return row?.on ?? true;
}

export async function documentHtml(
  db: Db,
  id: bigint,
): Promise<{ html: string; number: string | null }> {
  const d = await getDocument(db, id);
  const extra = await db
    .selectFrom('sales.documents')
    .select(['seller_snapshot', 'print_template_version_id'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  const { seller: current, logo } = await company(db);
  const seller = (extra.seller_snapshot as Seller | null) ?? current;
  const settings = await settingsOf(
    db,
    extra.print_template_version_id,
    d.docType === 'credit_note' ? 'credit_note_a4' : 'tax_invoice_a4',
  );
  const deductions = d.lines.filter((l) => l.lineKind === 'advance_deduction');
  const items = d.lines.filter((l) => l.lineKind !== 'advance_deduction');
  const before = items.reduce(
    (s, l) => ({ net: s.net + BigInt(l.netFils), vat: s.vat + BigInt(l.vatFils) }),
    { net: 0n, vat: 0n },
  );
  const doc: PrintDocument = {
    kind: d.docType,
    format: d.invoiceFormat,
    number: d.docNumber,
    status: d.status === 'issued' ? 'final' : 'draft',
    copy: d.status === 'issued' && d.printCount > 1 && (await markCopies(db)),
    dates: [
      ...(d.issueDate
        ? [{ label: ['تاريخ الإصدار', 'Issue date'] as [string, string], value: date(d.issueDate) }]
        : []),
      ...(d.supplyDate && d.supplyDate !== d.issueDate
        ? [
            {
              label: ['تاريخ التوريد', 'Date of supply'] as [string, string],
              value: date(d.supplyDate),
            },
          ]
        : []),
      ...(d.dueDate && settings.optional?.dueDate !== false
        ? [{ label: ['تاريخ الاستحقاق', 'Due date'] as [string, string], value: date(d.dueDate) }]
        : []),
    ],
    customer: {
      name: d.billToName,
      nameAlt: d.billToNameAlt,
      // The customer's TRN appears on a full tax invoice only (decision 0010).
      trn: d.invoiceFormat === 'full' ? d.billToTrn : null,
      address: d.billToAddress,
      phone: d.billToPhone,
    },
    reference: d.originalDocumentNumber
      ? { label: ['المستند الأصلي', 'Original document'], value: d.originalDocumentNumber }
      : null,
    lines: d.lines.map((l) => ({
      descriptionAr: l.descriptionAr,
      descriptionEn: l.descriptionEn,
      quantityMilli: l.quantityMilli,
      unitPrice4dp: l.unitPrice4dp,
      discountFils: (BigInt(l.lineDiscountFils) + BigInt(l.docDiscountAllocFils)).toString(),
      netFils: l.netFils,
      vatRateBp: l.vatRateBp,
      vatFils: l.vatFils,
      grossFils: l.grossFils,
      deduction: l.lineKind === 'advance_deduction',
    })),
    totals: [
      ...(deductions.length > 0
        ? [
            {
              label: ['الإجمالي قبل الخصم', 'Total before deductions'] as [string, string],
              fils: (before.net + before.vat).toString(),
            },
            {
              label: ['يُخصم: دفعات سابقة', 'Less: earlier payments'] as [string, string],
              fils: deductions.reduce((s, l) => s + BigInt(l.grossFils), 0n).toString(),
            },
          ]
        : []),
      { label: ['المبلغ الخاضع للضريبة', 'Taxable amount'], fils: d.netFils },
      { label: ['ضريبة القيمة المضافة', 'VAT'], fils: d.vatFils },
      { label: ['الإجمالي المستحق', 'Total payable'], fils: d.totalFils, strong: true },
    ],
    notes: [d.reasonText, d.notes].filter(Boolean).join(' — ') || null,
    logoDataUri: logo,
  };
  return { html: renderHtml(doc, seller, settings), number: d.docNumber };
}

export async function quotationHtml(db: Db, id: bigint): Promise<{ html: string; number: string }> {
  const q = await getQuotation(db, id);
  const extra = await db
    .selectFrom('sales.quotations')
    .select('print_template_version_id')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  const { seller, logo } = await company(db);
  const settings = await settingsOf(db, extra.print_template_version_id, 'quotation_a4');
  const number = q.revision > 1 ? `${q.docNumber}/${q.revision}` : q.docNumber;
  const doc: PrintDocument = {
    kind: 'quotation',
    number,
    status: q.status === 'draft' ? 'draft' : 'final',
    copy: false,
    dates: [
      { label: ['التاريخ', 'Date'], value: date(q.quotationDate) },
      { label: ['صالح حتى', 'Valid until'], value: date(q.validUntil) },
    ],
    customer: { name: q.billToName, trn: q.billToTrn },
    reference: q.subject ? { label: ['الموضوع', 'Subject'], value: q.subject } : null,
    lines: q.lines
      .filter((l) => !l.isOptional)
      .map((l) => ({
        descriptionAr: l.descriptionAr,
        descriptionEn: l.descriptionEn,
        quantityMilli: l.quantityMilli,
        unitPrice4dp: l.unitPrice4dp,
        discountFils: (BigInt(l.lineDiscountFils) + BigInt(l.docDiscountAllocFils)).toString(),
        netFils: l.netFils,
        vatRateBp: l.vatRateBp,
        vatFils: l.vatFils,
        grossFils: l.grossFils,
      })),
    totals: [
      { label: ['المبلغ قبل الضريبة', 'Amount before VAT'], fils: q.netFils },
      { label: ['ضريبة القيمة المضافة', 'VAT'], fils: q.vatFils },
      { label: ['الإجمالي', 'Total'], fils: q.totalFils, strong: true },
    ],
    notes: q.notes,
    logoDataUri: logo,
  };
  const withTerms: TemplateSettings = {
    ...settings,
    texts: {
      ...settings.texts,
      termsAr: q.termsAr ?? settings.texts?.termsAr ?? '',
      termsEn: q.termsEn ?? settings.texts?.termsEn ?? '',
    },
  };
  return { html: renderHtml(doc, seller, withTerms), number };
}

export async function receiptHtml(db: Db, id: bigint): Promise<{ html: string; number: string }> {
  const p = await getPayment(db, id);
  const c = await db
    .selectFrom('md.customers')
    .select(['name', 'trn', 'phone'])
    .where('id', '=', BigInt(p.customerId))
    .executeTakeFirstOrThrow();
  const extra = await db
    .selectFrom('sales.payments')
    .select('print_template_version_id')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  const { seller, logo } = await company(db);
  const settings = await settingsOf(db, extra.print_template_version_id, 'receipt_a4');
  const doc: PrintDocument = {
    kind: 'receipt',
    number: p.docNumber,
    status: 'final',
    copy: false,
    dates: [{ label: ['التاريخ', 'Date'], value: date(p.paymentDate) }],
    customer: { name: c.name, trn: c.trn, phone: c.phone },
    reference: p.reference ? { label: ['المرجع', 'Reference'], value: p.reference } : null,
    lines: [],
    table: {
      head: [
        ['المستند', 'Document'],
        ['المبلغ', 'Amount'],
      ],
      rows: p.allocations.map((a) => [
        a.docNumber ?? (a.docType === 'opening_balance' ? 'Opening balance' : '—'),
        money(a.amountFils),
      ]),
    },
    totals: [{ label: ['المبلغ المستلم', 'Amount received'], fils: p.amountFils, strong: true }],
    notes: p.notes,
    logoDataUri: logo,
  };
  return { html: renderHtml(doc, seller, settings), number: p.docNumber };
}

export async function statementHtml(
  db: Db,
  customerId: bigint,
  from: string,
  to: string,
): Promise<string> {
  const st = await statement(db, customerId, { from, to });
  const c = await db
    .selectFrom('md.customers')
    .select(['name', 'trn', 'phone'])
    .where('id', '=', customerId)
    .executeTakeFirstOrThrow();
  const { seller, logo } = await company(db);
  const settings = await settingsOf(db, null, 'statement_a4');
  const doc: PrintDocument = {
    kind: 'statement',
    number: null,
    status: 'final',
    copy: false,
    dates: [
      { label: ['من', 'From'], value: date(from) },
      { label: ['إلى', 'To'], value: date(to) },
    ],
    customer: { name: c.name, trn: c.trn, phone: c.phone },
    lines: [],
    table: {
      head: [
        ['التاريخ', 'Date'],
        ['المستند', 'Document'],
        ['مدين', 'Debit'],
        ['دائن', 'Credit'],
        ['الرصيد', 'Balance'],
      ],
      rows: st.lines.map((l) => [
        date(l.date),
        l.docNumber ?? l.kind,
        money(l.debitFils),
        money(l.creditFils),
        money(l.balanceFils),
      ]),
    },
    totals: [
      { label: ['الرصيد الافتتاحي', 'Opening balance'], fils: st.openingFils },
      { label: ['الرصيد الختامي', 'Closing balance'], fils: st.closingFils, strong: true },
    ],
    logoDataUri: logo,
  };
  return renderHtml(doc, seller, settings);
}
