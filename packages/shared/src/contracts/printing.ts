/**
 * The print designer (decisions 0020, 0064–0067): the settings of a template version, which
 * optional fields each document offers, and which fields are locked because UAE VAT law requires
 * them (Executive Regulation, Articles 59 and 60). Locked fields are printed whatever the
 * settings say; the settings only choose the look and the optional fields.
 */
import { z } from 'zod';
import { IdText } from './auth';
import { RowVersion } from './common';

/** The templates the owner designs. Receipts and statements print with the A4 invoice's design. */
export const DESIGNED_KINDS = [
  'tax_invoice_a4',
  'quotation_a4',
  'credit_note_a4',
  'receipt_thermal',
] as const;
export type DesignedKind = (typeof DESIGNED_KINDS)[number];

export const OPTIONAL_FIELDS = [
  'logo',
  'sellerAddress',
  'sellerTrn',
  'sellerContact',
  'welcome',
  'customerAddress',
  'customerPhone',
  'poNumber',
  'itemCode',
  'lineDiscount',
  'amountInWords',
  'bankDetails',
  'terms',
  'notes',
  'signature',
  'salesperson',
  'dueDate',
  'cashierName',
] as const;
export type OptionalField = (typeof OPTIONAL_FIELDS)[number];

/**
 * The optional fields each template offers. The seller's address and TRN are optional on the
 * quotation only (not a tax document); on tax documents they are locked.
 */
export const FIELDS_BY_KIND: Record<DesignedKind, readonly OptionalField[]> = {
  tax_invoice_a4: [
    'logo',
    'sellerContact',
    'welcome',
    'customerAddress',
    'customerPhone',
    'poNumber',
    'itemCode',
    'lineDiscount',
    'amountInWords',
    'bankDetails',
    'terms',
    'notes',
    'signature',
    'salesperson',
    'dueDate',
  ],
  quotation_a4: [
    'logo',
    'sellerAddress',
    'sellerTrn',
    'sellerContact',
    'welcome',
    'customerAddress',
    'customerPhone',
    'poNumber',
    'itemCode',
    'lineDiscount',
    'amountInWords',
    'bankDetails',
    'terms',
    'notes',
    'signature',
    'salesperson',
  ],
  credit_note_a4: [
    'logo',
    'sellerContact',
    'customerAddress',
    'customerPhone',
    'itemCode',
    'amountInWords',
    'terms',
    'notes',
    'signature',
  ],
  receipt_thermal: [
    'logo',
    'sellerContact',
    'welcome',
    'customerAddress',
    'customerPhone',
    'itemCode',
    'amountInWords',
    'terms',
    'cashierName',
  ],
};

/** The fields always printed (decision 0064), per template; the designer lists them as "Required". */
export const LOCKED_FIELDS = [
  'title',
  'sellerName',
  'sellerAddressTrn',
  'customerFull',
  'numberAndDates',
  'lines',
  'discount',
  'vat',
  'totals',
  'deductions',
  'originalInvoice',
  'reason',
] as const;
export type LockedField = (typeof LOCKED_FIELDS)[number];

export const LOCKED_BY_KIND: Record<DesignedKind, readonly LockedField[]> = {
  tax_invoice_a4: [
    'title',
    'sellerName',
    'sellerAddressTrn',
    'customerFull',
    'numberAndDates',
    'lines',
    'discount',
    'vat',
    'totals',
    'deductions',
  ],
  quotation_a4: ['title', 'sellerName', 'numberAndDates', 'lines', 'totals'],
  credit_note_a4: [
    'title',
    'sellerName',
    'sellerAddressTrn',
    'customerFull',
    'numberAndDates',
    'originalInvoice',
    'lines',
    'vat',
    'totals',
    'reason',
  ],
  receipt_thermal: [
    'title',
    'sellerName',
    'sellerAddressTrn',
    'customerFull',
    'numberAndDates',
    'lines',
    'vat',
    'totals',
  ],
};

export const TEMPLATE_TEXTS = [
  'welcomeAr',
  'welcomeEn',
  'termsAr',
  'termsEn',
  'footerAr',
  'footerEn',
] as const;
export type TemplateText = (typeof TEMPLATE_TEXTS)[number];

const Text = z.string().trim().max(500);

export const TemplateSettings = z.object({
  language: z.enum(['both', 'ar', 'en']),
  logoPosition: z.enum(['beside', 'center', 'opposite']),
  logoSizeMm: z.number().int().min(10).max(60),
  /** The main colour (A4): titles, the table header and the total. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  textSize: z.enum(['small', 'normal', 'large']),
  margins: z.enum(['narrow', 'normal', 'wide']),
  paperWidthMm: z.union([z.literal(80), z.literal(58)]),
  fields: z.object(
    Object.fromEntries(OPTIONAL_FIELDS.map((f) => [f, z.boolean()])) as Record<
      OptionalField,
      z.ZodBoolean
    >,
  ),
  texts: z.object(
    Object.fromEntries(TEMPLATE_TEXTS.map((k) => [k, Text])) as Record<TemplateText, typeof Text>,
  ),
  /** The bank account printed with "Bank details" (decision 0065). */
  bankAccountId: IdText.nullable(),
});
export type TemplateSettings = z.infer<typeof TemplateSettings>;

const DEFAULT_FIELDS: Record<OptionalField, boolean> = {
  logo: true,
  sellerAddress: true,
  sellerTrn: true,
  sellerContact: true,
  welcome: true,
  customerAddress: true,
  customerPhone: true,
  poNumber: true,
  itemCode: false,
  lineDiscount: true,
  amountInWords: false,
  bankDetails: false,
  terms: true,
  notes: true,
  signature: false,
  salesperson: true,
  dueDate: true,
  cashierName: true,
};

/** The original design of each template (decision 0050), used by "Default" in the designer. */
export function defaultTemplateSettings(kind: DesignedKind): TemplateSettings {
  return {
    language: 'both',
    logoPosition: 'beside',
    logoSizeMm: 28,
    color: '#111111',
    textSize: 'normal',
    margins: 'normal',
    paperWidthMm: 80,
    fields: {
      ...DEFAULT_FIELDS,
      ...(kind === 'receipt_thermal' ? { logo: false, itemCode: true } : {}),
    },
    texts: {
      welcomeAr: '',
      welcomeEn: '',
      termsAr: '',
      termsEn: '',
      footerAr: 'شكرًا لتعاملكم معنا',
      footerEn: 'Thank you for your business',
    },
    bankAccountId: null,
  };
}

/**
 * Reads a stored version's settings, whatever the version: the first versions (migration 0016)
 * used other names (`showLogo`, `logoPosition: 'start'`, `marginsMm`, `optional`). Anything
 * missing takes its default; anything unreadable is ignored.
 */
export function readTemplateSettings(kind: DesignedKind, raw: unknown): TemplateSettings {
  const base = defaultTemplateSettings(kind);
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const legacyOptional = (s.optional ?? {}) as Partial<Record<OptionalField, boolean>>;
  const candidate = {
    ...base,
    ...s,
    logoPosition:
      s.logoPosition === 'start' || s.logoPosition === undefined ? 'beside' : s.logoPosition,
    margins: typeof s.margins === 'string' ? s.margins : base.margins,
    paperWidthMm: s.paperWidthMm === 58 ? 58 : 80,
    fields: {
      ...base.fields,
      ...legacyOptional,
      ...(typeof s.showLogo === 'boolean' ? { logo: s.showLogo } : {}),
      ...(s.fields ?? {}),
    },
    texts: { ...base.texts, ...(s.texts ?? {}) },
    bankAccountId: typeof s.bankAccountId === 'string' ? s.bankAccountId : null,
  };
  const parsed = TemplateSettings.safeParse(candidate);
  return parsed.success ? parsed.data : base;
}

/** Whether a template prints an optional field: offered by its kind and switched on. */
export const shows = (kind: DesignedKind, settings: TemplateSettings, field: OptionalField) =>
  FIELDS_BY_KIND[kind].includes(field) && settings.fields[field];

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

export interface PrintTemplateItem {
  kind: DesignedKind;
  versionId: string;
  versionNo: number;
  savedAt: string;
  savedBy: { displayNameAr: string; displayNameEn: string } | null;
  settings: TemplateSettings;
}

export interface PrintTemplatesResponse {
  templates: PrintTemplateItem[];
  /** Active bank accounts the "Bank details" field can print. */
  bankAccounts: { id: string; bankName: string; accountName: string; iban: string }[];
  hasLogo: boolean;
  canEdit: boolean;
}

export interface PrintTemplateVersionItem {
  versionId: string;
  versionNo: number;
  savedAt: string;
  savedBy: { displayNameAr: string; displayNameEn: string } | null;
  note: string | null;
}

export const SaveTemplateRequest = z.object({
  settings: TemplateSettings,
  note: z.string().trim().max(200).optional(),
  /** The version the owner started from: saving over a newer one is refused (STALE_VERSION). */
  basedOnVersionId: IdText,
});
export type SaveTemplateRequest = z.infer<typeof SaveTemplateRequest>;

export const PreviewTemplateRequest = z.object({ settings: TemplateSettings });
export type PreviewTemplateRequest = z.infer<typeof PreviewTemplateRequest>;

export interface PreviewTemplateResponse {
  /** A4: the page as HTML (the same HTML the PDF is made from). */
  html: string | null;
}

// ---------------------------------------------------------------------------------------------
// Company bank accounts (decision 0065)
// ---------------------------------------------------------------------------------------------

export interface BankAccount {
  id: string;
  bankName: string;
  accountName: string;
  iban: string;
  swift: string | null;
  sortOrder: number;
  isActive: boolean;
  rowVersion: number;
}

export interface BankAccountsResponse {
  accounts: BankAccount[];
  canEdit: boolean;
}

export const SaveBankAccountRequest = z.object({
  bankName: z.string().trim().min(1).max(100),
  accountName: z.string().trim().min(1).max(150),
  /** Typed freely (spaces, lower case); saved as AE + 21 digits after its checksum is checked. */
  iban: z.string().trim().min(1).max(40),
  swift: z
    .string()
    .trim()
    .max(20)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  /** Absent when adding. */
  rowVersion: RowVersion.optional(),
});
export type SaveBankAccountRequest = z.infer<typeof SaveBankAccountRequest>;
