/**
 * Settings → Print designer (decisions 0020, 0064): the current version of each designed
 * template, its history, saving a new version (owner only, checked again by the database) and a
 * live preview of unsaved settings on a sample document. Versions are never changed or deleted;
 * every save is in the audit log.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  DESIGNED_KINDS,
  readTemplateSettings,
  type DesignedKind,
  type PrintTemplateItem,
  type PrintTemplatesResponse,
  type PrintTemplateVersionItem,
  type ReceiptLogoResponse,
  type SaveReceiptLogoRequest,
  type SaveTemplateRequest,
  type TemplateSettings,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { filledByDatabase } from '../../platform/db/stamped';
import { fieldError } from '../../platform/db/versioned';
import { AppError, ruleError } from '../../platform/errors/app-error';
import { listBankAccounts } from '../company/bank-accounts';
import { detectImageType, getLogo } from '../company/service';
import { company } from './service';
import { renderHtml, type PrintDocument } from './templates';

type Db = Kysely<DB> | Transaction<DB>;

const names = (r: { display_name_ar: string | null; display_name_en: string | null }) =>
  r.display_name_ar || r.display_name_en
    ? { displayNameAr: r.display_name_ar ?? '', displayNameEn: r.display_name_en ?? '' }
    : null;

export async function listTemplates(db: Db, canEdit: boolean): Promise<PrintTemplatesResponse> {
  const rows = await db
    .selectFrom('sys.print_templates as t')
    .innerJoin('sys.print_template_versions as v', 'v.id', 't.current_version_id')
    .leftJoin('auth.users as u', 'u.id', 'v.created_by')
    .select([
      't.doc_kind',
      'v.id',
      'v.version_no',
      'v.settings',
      'v.created_at',
      'u.display_name_ar',
      'u.display_name_en',
    ])
    .where('t.doc_kind', 'in', [...DESIGNED_KINDS])
    .execute();
  const templates = DESIGNED_KINDS.map((kind): PrintTemplateItem => {
    const r = rows.find((x) => x.doc_kind === kind);
    if (!r) throw new AppError('INTERNAL', `No template for ${kind}`);
    return {
      kind,
      versionId: r.id.toString(),
      versionNo: r.version_no,
      savedAt: r.created_at.toISOString(),
      savedBy: names(r),
      settings: readTemplateSettings(kind, r.settings),
    };
  });
  const logo = await db
    .selectFrom('sys.company_profile')
    .select(sql<boolean>`logo IS NOT NULL`.as('has'))
    .where('id', '=', 1)
    .executeTakeFirst();
  return {
    templates,
    bankAccounts: (await listBankAccounts(db, { activeOnly: true })).map((a) => ({
      id: a.id,
      bankName: a.bankName,
      accountName: a.accountName,
      iban: a.iban,
    })),
    hasLogo: logo?.has ?? false,
    hasReceiptLogo: (await receiptLogo(db)).own,
    canEdit,
  };
}

export async function listVersions(
  db: Db,
  kind: DesignedKind,
): Promise<PrintTemplateVersionItem[]> {
  const rows = await db
    .selectFrom('sys.print_template_versions as v')
    .innerJoin('sys.print_templates as t', 't.id', 'v.template_id')
    .leftJoin('auth.users as u', 'u.id', 'v.created_by')
    .select([
      'v.id',
      'v.version_no',
      'v.created_at',
      'v.note',
      'u.display_name_ar',
      'u.display_name_en',
    ])
    .where('t.doc_kind', '=', kind)
    .orderBy('v.version_no', 'desc')
    .execute();
  return rows.map((r) => ({
    versionId: r.id.toString(),
    versionNo: r.version_no,
    savedAt: r.created_at.toISOString(),
    savedBy: names(r),
    note: r.note,
  }));
}

/** A new version becomes the template's current one; refused when someone saved meanwhile. */
export async function saveTemplate(
  trx: Transaction<DB>,
  kind: DesignedKind,
  body: SaveTemplateRequest,
): Promise<PrintTemplateItem> {
  const template = await trx
    .selectFrom('sys.print_templates')
    .select(['id', 'current_version_id'])
    .where('doc_kind', '=', kind)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (template.current_version_id?.toString() !== body.basedOnVersionId) {
    throw new AppError('STALE_VERSION', 'The template was saved by someone else meanwhile');
  }
  const settings: TemplateSettings = body.settings;
  if (settings.bankAccountId) {
    const active = await trx
      .selectFrom('sys.company_bank_accounts')
      .select('id')
      .where('id', '=', BigInt(settings.bankAccountId))
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (!active) throw fieldError('settings.bankAccountId', 'unknown');
  }
  if (kind === 'receipt_thermal' && settings.fields.bankDetails) {
    // Not offered on the thermal receipt; never stored as on.
    settings.fields.bankDetails = false;
  }
  const version = await trx
    .insertInto('sys.print_template_versions')
    .values(
      // The version number is the next of its template, set by the database.
      filledByDatabase('sys.print_template_versions', {
        template_id: template.id,
        settings: JSON.stringify(settings),
        note: body.note ?? null,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .updateTable('sys.print_templates')
    .set({ current_version_id: version.id })
    .where('id', '=', template.id)
    .execute();
  const saved = (await listTemplates(trx, true)).templates.find((t) => t.kind === kind)!;
  return saved;
}

// ---------------------------------------------------------------------------------------------
// Preview: a sample document with the unsaved settings (A4 only; the receipt is drawn by the PC)
// ---------------------------------------------------------------------------------------------

const SAMPLE_LINES: PrintDocument['lines'] = [
  {
    descriptionAr: 'مضخة مسبح · 1 حصان',
    descriptionEn: 'Pool pump · 1 HP',
    itemCode: 'PUMP-1HP',
    quantityMilli: '2000',
    unitPrice4dp: '9500000',
    discountFils: '10000',
    netFils: '180000',
    vatRateBp: 500,
    vatFils: '9000',
    grossFils: '189000',
  },
  {
    descriptionAr: 'فلتر رملي · 24 بوصة',
    descriptionEn: 'Sand filter · 24 in',
    itemCode: 'FILTER-24',
    quantityMilli: '1000',
    unitPrice4dp: '7500000',
    discountFils: '0',
    netFils: '75000',
    vatRateBp: 500,
    vatFils: '3750',
    grossFils: '78750',
  },
  {
    descriptionAr: 'تركيب وتشغيل',
    descriptionEn: 'Installation & commissioning',
    itemCode: 'SRV-INSTALL',
    quantityMilli: '1000',
    unitPrice4dp: '4000000',
    discountFils: '0',
    netFils: '40000',
    vatRateBp: 500,
    vatFils: '2000',
    grossFils: '42000',
  },
];

function sampleDocument(kind: DesignedKind, logo: string | null): PrintDocument {
  const base: PrintDocument = {
    kind: 'invoice',
    format: 'full',
    number: 'INV-2026-000112',
    status: 'final',
    copy: false,
    dates: [{ label: ['تاريخ الإصدار', 'Issue date'], value: '07/10/2026' }],
    dueDate: '06/11/2026',
    customer: {
      name: 'الحديقة الخضراء للمقاولات ذ.م.م',
      nameAlt: 'Green Garden Contracting LLC',
      trn: '100234567800003',
      address: 'المنطقة الصناعية، العين',
      phone: '+971 50 123 4567',
    },
    customerPo: 'PO-5531',
    salesperson: 'محمد ياسر · Mohamed Yasser',
    lines: SAMPLE_LINES,
    totals: [
      { label: ['إجمالي الخصم', 'Total discount'], fils: '10000' },
      { label: ['المبلغ الخاضع للضريبة', 'Taxable amount'], fils: '295000' },
      { label: ['ضريبة القيمة المضافة 5%', 'VAT 5%'], fils: '14750' },
      { label: ['الإجمالي المستحق', 'Total payable'], fils: '309750', strong: true },
    ],
    wordsFils: '309750',
    notes: 'التسليم خلال أسبوع · Delivery within a week',
    logoDataUri: logo,
    // Decision 0114: a credit customer who owed 1,250.00 and paid 1,000.00 at issue.
    account: {
      previousFils: '125000',
      thisInvoiceFils: '309750',
      paidNowFils: '100000',
      credit: true,
    },
  };
  if (kind === 'quotation_a4') {
    return {
      ...base,
      kind: 'quotation',
      format: undefined,
      number: 'QT-2026-000045',
      dates: [
        { label: ['التاريخ', 'Date'], value: '07/10/2026' },
        { label: ['صالح حتى', 'Valid until'], value: '22/10/2026' },
      ],
      dueDate: null,
      totals: [
        { label: ['المبلغ قبل الضريبة', 'Amount before VAT'], fils: '295000' },
        { label: ['ضريبة القيمة المضافة 5%', 'VAT 5%'], fils: '14750' },
        { label: ['الإجمالي', 'Total'], fils: '309750', strong: true },
      ],
    };
  }
  if (kind === 'credit_note_a4') {
    const line = { ...SAMPLE_LINES[1]!, discountFils: '0' };
    return {
      ...base,
      kind: 'credit_note',
      number: 'CN-2026-000009',
      dueDate: null,
      customerPo: null,
      salesperson: null,
      original: { number: 'INV-2026-000098', date: '01/10/2026' },
      reason: 'إرجاع بضاعة · Goods returned',
      lines: [line],
      totals: [
        { label: ['المبلغ الخاضع للضريبة', 'Taxable amount'], fils: line.netFils },
        { label: ['ضريبة القيمة المضافة 5%', 'VAT 5%'], fils: line.vatFils },
        { label: ['الإجمالي', 'Total'], fils: line.grossFils, strong: true },
      ],
      wordsFils: line.grossFils,
    };
  }
  return base;
}

export async function previewTemplate(
  db: Db,
  kind: DesignedKind,
  settings: TemplateSettings,
): Promise<string | null> {
  if (kind === 'receipt_thermal') return null;
  const { seller, logo } = await company(db);
  const account = settings.bankAccountId
    ? (await listBankAccounts(db)).find((a) => a.id === settings.bankAccountId)
    : undefined;
  return renderHtml(sampleDocument(kind, logo), seller, {
    kind,
    settings,
    bankAccount: account ?? null,
  });
}

// ---------------------------------------------------------------------------------------------
// The thermal receipt's own logo (decision 0075)
// ---------------------------------------------------------------------------------------------

/** The logo the receipt prints: its own if set, else the company logo. */
export async function receiptLogo(db: Db): Promise<ReceiptLogoResponse> {
  const row = await db
    .selectFrom('sys.receipt_logo')
    .select(['logo', 'logo_mime'])
    .where('id', '=', 1)
    .executeTakeFirst();
  if (row?.logo && row.logo_mime) {
    return {
      logo: {
        type: row.logo_mime as 'image/png' | 'image/jpeg',
        dataBase64: row.logo.toString('base64'),
      },
      own: true,
    };
  }
  return { logo: (await getLogo(db)).logo, own: false };
}

/** Sets the receipt's own logo, or removes it (back to the company logo). The content is checked. */
export async function saveReceiptLogo(
  trx: Transaction<DB>,
  body: SaveReceiptLogoRequest,
): Promise<ReceiptLogoResponse> {
  let logo: Buffer | null = null;
  if (body.logo) {
    logo = Buffer.from(body.logo.dataBase64, 'base64');
    if (logo.length === 0 || logo.length > 524_288 || detectImageType(logo) !== body.logo.type) {
      throw ruleError('LOGO_INVALID', 'The logo must be a PNG or JPEG file of at most 512 KB');
    }
  }
  await trx
    .updateTable('sys.receipt_logo')
    .set({ logo, logo_mime: body.logo ? body.logo.type : null })
    .where('id', '=', 1)
    .execute();
  return receiptLogo(trx);
}
