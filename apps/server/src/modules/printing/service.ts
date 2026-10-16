/**
 * What each printed document shows. Every issued document prints with the template version stored
 * on it (decisions 0020, 0050), so a reprint looks like the original; receipts and statements use
 * the A4 invoice's design (0064). Issued documents print the seller details frozen at issue; a
 * reprint is marked "Copy" (decision 0008, setting print.mark_reprints_as_copy).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  readTemplateSettings,
  type DesignedKind,
  type TemplateSettings,
} from '@artepool/shared/contracts';
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
  type PrintBankAccount,
  type PrintDocument,
  type Seller,
} from './templates';

type Db = Kysely<DB> | Transaction<DB>;

export async function company(db: Db): Promise<{ seller: Seller; logo: string | null }> {
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

/** A version's settings (the stored one, or the kind's current one), read with their defaults. */
export async function settingsOf(
  db: Db,
  versionId: bigint | null,
  kind: DesignedKind,
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
  return readTemplateSettings(kind, row?.settings);
}

/** The bank account a template prints (decision 0065); kept even after it is deactivated. */
export async function bankAccountOf(
  db: Db,
  settings: TemplateSettings,
): Promise<PrintBankAccount | null> {
  if (!settings.fields.bankDetails || !settings.bankAccountId) return null;
  const a = await db
    .selectFrom('sys.company_bank_accounts')
    .select(['bank_name', 'account_name', 'iban', 'swift'])
    .where('id', '=', BigInt(settings.bankAccountId))
    .executeTakeFirst();
  return a
    ? { bankName: a.bank_name, accountName: a.account_name, iban: a.iban, swift: a.swift }
    : null;
}

async function markCopies(db: Db): Promise<boolean> {
  const row = await db
    .selectFrom('sys.settings')
    .select(sql<boolean>`coalesce((value #>> '{}')::boolean, true)`.as('on'))
    .where('key', '=', 'print.mark_reprints_as_copy')
    .executeTakeFirst();
  return row?.on ?? true;
}

async function render(
  db: Db,
  doc: PrintDocument,
  seller: Seller,
  kind: DesignedKind,
  settings: TemplateSettings,
): Promise<string> {
  return renderHtml(doc, seller, {
    kind,
    settings,
    bankAccount: await bankAccountOf(db, settings),
  });
}

const userName = (u: { display_name_ar: string | null; display_name_en: string | null }) =>
  [u.display_name_ar, u.display_name_en].filter(Boolean).join(' · ') || null;

export async function documentHtml(
  db: Db,
  id: bigint,
): Promise<{ html: string; number: string | null }> {
  const d = await getDocument(db, id);
  const extra = await db
    .selectFrom('sales.documents as d')
    .leftJoin('sales.documents as o', 'o.id', 'd.original_document_id')
    .leftJoin('auth.users as s', 's.id', 'd.salesperson_id')
    .select([
      'd.seller_snapshot',
      'd.print_template_version_id',
      'o.issue_date as original_date',
      's.display_name_ar',
      's.display_name_en',
    ])
    .where('d.id', '=', id)
    .executeTakeFirstOrThrow();
  const { seller: current, logo } = await company(db);
  const seller = (extra.seller_snapshot as Seller | null) ?? current;
  const kind: DesignedKind = d.docType === 'credit_note' ? 'credit_note_a4' : 'tax_invoice_a4';
  const settings = await settingsOf(db, extra.print_template_version_id, kind);
  const deductions = d.lines.filter((l) => l.lineKind === 'advance_deduction');
  const items = d.lines.filter((l) => l.lineKind !== 'advance_deduction');
  const before = items.reduce(
    (s, l) => ({ net: s.net + BigInt(l.netFils), vat: s.vat + BigInt(l.vatFils) }),
    { net: 0n, vat: 0n },
  );
  const isNote = d.docType === 'credit_note' || d.docType === 'debit_note';
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
    ],
    dueDate: d.dueDate ? date(d.dueDate) : null,
    customer: {
      name: d.billToName,
      nameAlt: d.billToNameAlt,
      // The customer's TRN appears on a full tax invoice only (decision 0010).
      trn: d.invoiceFormat === 'full' ? d.billToTrn : null,
      address: d.billToAddress,
      phone: d.billToPhone,
    },
    customerPo: d.customerPo,
    salesperson: extra.display_name_ar || extra.display_name_en ? userName(extra) : null,
    original:
      isNote && d.originalDocumentNumber
        ? {
            number: d.originalDocumentNumber,
            date: extra.original_date ? date(String(extra.original_date).slice(0, 10)) : null,
          }
        : null,
    reason: isNote ? d.reasonText : null,
    lines: d.lines.map((l) => ({
      descriptionAr: l.descriptionAr,
      descriptionEn: l.descriptionEn,
      itemCode: l.itemCode,
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
      ...(d.discountTotalFils !== '0'
        ? [
            {
              label: ['إجمالي الخصم', 'Total discount'] as [string, string],
              fils: d.discountTotalFils,
            },
          ]
        : []),
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
    wordsFils: d.totalFils,
    notes: d.notes,
    logoDataUri: logo,
  };
  return { html: await render(db, doc, seller, kind, settings), number: d.docNumber };
}

export async function quotationHtml(db: Db, id: bigint): Promise<{ html: string; number: string }> {
  const q = await getQuotation(db, id);
  const extra = await db
    .selectFrom('sales.quotations as q')
    .leftJoin('auth.users as s', 's.id', 'q.salesperson_id')
    .select([
      'q.print_template_version_id',
      'q.bill_to_address',
      'q.bill_to_phone',
      's.display_name_ar',
      's.display_name_en',
    ])
    .where('q.id', '=', id)
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
    customer: {
      name: q.billToName,
      trn: q.billToTrn,
      address: extra.bill_to_address,
      phone: extra.bill_to_phone,
    },
    customerPo: q.customerPo,
    salesperson: extra.display_name_ar || extra.display_name_en ? userName(extra) : null,
    reference: q.subject ? { label: ['الموضوع', 'Subject'], value: q.subject } : null,
    lines: q.lines
      .filter((l) => !l.isOptional)
      .map((l) => ({
        descriptionAr: l.descriptionAr,
        descriptionEn: l.descriptionEn,
        itemCode: l.itemCode,
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
    wordsFils: q.totalFils,
    notes: q.notes,
    logoDataUri: logo,
  };
  // A quotation's own terms replace the template's.
  const withTerms: TemplateSettings = {
    ...settings,
    texts: {
      ...settings.texts,
      termsAr: q.termsAr ?? settings.texts.termsAr,
      termsEn: q.termsEn ?? settings.texts.termsEn,
    },
  };
  return { html: await render(db, doc, seller, 'quotation_a4', withTerms), number };
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
  const settings = await settingsOf(db, extra.print_template_version_id, 'tax_invoice_a4');
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
    wordsFils: p.amountFils,
    notes: p.notes,
    logoDataUri: logo,
  };
  return {
    html: await render(db, doc, seller, 'tax_invoice_a4', settings),
    number: p.docNumber,
  };
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
  const settings = await settingsOf(db, null, 'tax_invoice_a4');
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
  return render(db, doc, seller, 'tax_invoice_a4', settings);
}
