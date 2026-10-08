/**
 * What each import template contains, and how each row is checked (decision 0031). Rows are
 * judged by the same rules as the screens and the database; a check collects every problem
 * instead of stopping at the first.
 */
import type { Kysely } from 'kysely';
import {
  CODE_PATTERN,
  BARCODE_PATTERN,
  fitsUnitDecimals,
  MoneyFormatError,
  normalizeCode,
  normalizePhone,
  normalizeTrn,
  parse4dp,
  parseQuantity,
} from '@artepool/shared';
import {
  EMIRATES,
  type CustomerType,
  type Emirate,
  type ImportEntity,
  type ImportIssue,
  type ImportProblem,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { cell, type ColumnSpec, type SheetRow } from './xlsx';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Lower case, Arabic letter variants unified (as `sys.normalize_search`), for matching choices. */
function simplify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىی]/g, 'ي')
    .replace(/[ً-ْـ]/g, '')
    .replace(/[\s_-]+/g, ' ');
}

/** Columns of every template, with their Arabic and English headers. */
export const COLUMNS: Readonly<Record<ImportEntity, readonly ColumnSpec[]>> = {
  items: [
    { key: 'code', ar: 'الكود', en: 'Code' },
    { key: 'type', ar: 'النوع', en: 'Type' },
    { key: 'name_ar', ar: 'الاسم بالعربية', en: 'Arabic name' },
    { key: 'name_en', ar: 'الاسم بالإنجليزية', en: 'English name' },
    { key: 'category', ar: 'التصنيف', en: 'Category' },
    { key: 'unit', ar: 'الوحدة', en: 'Unit' },
    { key: 'vat', ar: 'فئة الضريبة', en: 'VAT category' },
    { key: 'price', ar: 'سعر البيع', en: 'Sale price' },
    { key: 'price_includes_vat', ar: 'السعر شامل الضريبة', en: 'Price includes VAT' },
    { key: 'barcode', ar: 'الباركود', en: 'Barcode' },
    { key: 'reorder_level', ar: 'حد إعادة الطلب', en: 'Reorder level' },
    { key: 'sellable', ar: 'للبيع', en: 'For sale' },
    { key: 'business_line', ar: 'قسم العمل', en: 'Line of business' },
    { key: 'description_ar', ar: 'الوصف بالعربية', en: 'Arabic description' },
    { key: 'description_en', ar: 'الوصف بالإنجليزية', en: 'English description' },
  ],
  item_prices: [
    { key: 'code', ar: 'الكود', en: 'Code' },
    { key: 'price', ar: 'سعر البيع', en: 'Sale price' },
    { key: 'price_includes_vat', ar: 'السعر شامل الضريبة', en: 'Price includes VAT' },
  ],
  customers: [
    { key: 'type', ar: 'النوع', en: 'Type' },
    { key: 'name', ar: 'الاسم', en: 'Name' },
    { key: 'name_alt', ar: 'الاسم باللغة الأخرى', en: 'Name in the other language' },
    { key: 'phone', ar: 'الهاتف', en: 'Phone' },
    { key: 'phone_alt', ar: 'هاتف آخر', en: 'Other phone' },
    { key: 'email', ar: 'البريد الإلكتروني', en: 'Email' },
    { key: 'address', ar: 'العنوان', en: 'Address' },
    { key: 'area', ar: 'المنطقة', en: 'Area' },
    { key: 'city', ar: 'المدينة', en: 'City' },
    { key: 'emirate', ar: 'الإمارة', en: 'Emirate' },
    { key: 'vat_registered', ar: 'مسجل في الضريبة', en: 'VAT-registered' },
    { key: 'trn', ar: 'الرقم الضريبي', en: 'TRN' },
    { key: 'notes', ar: 'ملاحظات', en: 'Notes' },
  ],
  suppliers: [
    { key: 'name', ar: 'الاسم', en: 'Name' },
    { key: 'name_alt', ar: 'الاسم باللغة الأخرى', en: 'Name in the other language' },
    { key: 'phone', ar: 'الهاتف', en: 'Phone' },
    { key: 'email', ar: 'البريد الإلكتروني', en: 'Email' },
    { key: 'address', ar: 'العنوان', en: 'Address' },
    { key: 'city', ar: 'المدينة', en: 'City' },
    { key: 'emirate', ar: 'الإمارة', en: 'Emirate' },
    { key: 'country', ar: 'الدولة', en: 'Country' },
    { key: 'vat_registered', ar: 'مسجل في الضريبة', en: 'VAT-registered' },
    { key: 'trn', ar: 'الرقم الضريبي', en: 'TRN' },
    { key: 'payment_terms_days', ar: 'أيام السداد', en: 'Payment terms (days)' },
    { key: 'notes', ar: 'ملاحظات', en: 'Notes' },
  ],
};

/** Columns Excel must keep as text (a leading 0 or 15 digits must survive). */
export const TEXT_COLUMNS = ['code', 'barcode', 'phone', 'phone_alt', 'trn'];

/** Columns that must be filled in every row. */
const REQUIRED: Readonly<Record<ImportEntity, readonly string[]>> = {
  items: ['type', 'name_ar', 'name_en', 'category', 'unit'],
  item_prices: ['code', 'price', 'price_includes_vat'],
  customers: ['type', 'name', 'phone'],
  suppliers: ['name'],
};

const MAX_TEXT: Readonly<Record<string, number>> = {
  name_ar: 200,
  name_en: 200,
  name: 200,
  name_alt: 200,
  email: 200,
  address: 300,
  area: 100,
  city: 100,
  notes: 2000,
  description_ar: 1000,
  description_en: 1000,
};

const YES = ['yes', 'y', '1', 'true', 'نعم'];
const NO = ['no', 'n', '0', 'false', 'لا'];

const ITEM_TYPES: Readonly<Record<string, 'stock' | 'service'>> = {
  stock: 'stock',
  [simplify('مخزني')]: 'stock',
  [simplify('صنف مخزني')]: 'stock',
  service: 'service',
  [simplify('خدمة')]: 'service',
};

const CUSTOMER_TYPES: Readonly<Record<string, CustomerType>> = {
  individual: 'individual',
  [simplify('فرد')]: 'individual',
  contractor: 'contractor',
  [simplify('مقاول')]: 'contractor',
  company: 'company',
  [simplify('شركة')]: 'company',
};

const EMIRATE_NAMES: Readonly<Record<Emirate, readonly string[]>> = {
  abu_dhabi: ['abu dhabi', 'أبوظبي', 'أبو ظبي'],
  dubai: ['dubai', 'دبي'],
  sharjah: ['sharjah', 'الشارقة'],
  ajman: ['ajman', 'عجمان'],
  umm_al_quwain: ['umm al quwain', 'أم القيوين'],
  ras_al_khaimah: ['ras al khaimah', 'رأس الخيمة'],
  fujairah: ['fujairah', 'الفجيرة'],
};

/** Collects the problems of one file; every valid row becomes a record. */
export class Checker {
  readonly issues: ImportIssue[] = [];
  private readonly badRows = new Set<number>();

  constructor(private readonly entity: ImportEntity) {}

  add(row: number, column: string | null, problem: ImportProblem): void {
    this.issues.push({ row, column: column ? this.header(column) : null, problem });
    this.badRows.add(row);
  }

  isBad(row: number): boolean {
    return this.badRows.has(row);
  }

  get invalidRows(): number {
    return this.badRows.size;
  }

  /** The column as its template header shows it, for the report. */
  header(key: string): string {
    const column = COLUMNS[this.entity].find((c) => c.key === key);
    return column ? `${column.ar} / ${column.en}` : key;
  }

  /** Required columns filled, texts not too long. */
  basics(row: SheetRow): void {
    for (const key of REQUIRED[this.entity]) {
      if (cell(row, key) === null) this.add(row.row, key, 'required');
    }
    for (const [key, max] of Object.entries(MAX_TEXT)) {
      const value = cell(row, key);
      if (value && value.length > max) this.add(row.row, key, 'too_long');
    }
  }

  yesNo(row: SheetRow, key: string, fallback: boolean | null): boolean | null {
    const value = cell(row, key);
    if (value === null) return fallback;
    const text = simplify(value);
    if (YES.includes(text)) return true;
    if (NO.includes(text)) return false;
    this.add(row.row, key, 'invalid_choice');
    return null;
  }

  price(row: SheetRow, key: string): bigint | null {
    const value = cell(row, key);
    if (value === null) return null;
    try {
      const price = parse4dp(value);
      if (price < 0n) throw new MoneyFormatError('negative');
      return price;
    } catch {
      this.add(row.row, key, 'invalid_price');
      return null;
    }
  }

  quantity(row: SheetRow, key: string, decimals: number | null): bigint | null {
    const value = cell(row, key);
    if (value === null) return null;
    try {
      const quantity = parseQuantity(value);
      if (quantity < 0n) throw new MoneyFormatError('negative');
      if (decimals !== null && !fitsUnitDecimals(quantity, decimals)) {
        this.add(row.row, key, 'too_many_decimals');
        return null;
      }
      return quantity;
    } catch {
      this.add(row.row, key, 'invalid_quantity');
      return null;
    }
  }

  emirate(row: SheetRow): Emirate | null {
    const value = cell(row, 'emirate');
    if (value === null) return null;
    const text = simplify(value);
    for (const emirate of EMIRATES) {
      if (
        text === emirate.replace(/_/g, ' ') ||
        EMIRATE_NAMES[emirate].some((n) => simplify(n) === text)
      ) {
        return emirate;
      }
    }
    this.add(row.row, 'emirate', 'invalid_choice');
    return null;
  }

  phone(row: SheetRow, key: string): string | null {
    let value = cell(row, key);
    if (value === null) return null;
    // A phone typed into a number cell loses its leading 0: 501234567 → 0501234567.
    if (/^5[0-9]{8}$/.test(value)) value = `0${value}`;
    const phone = normalizePhone(value);
    if (!phone) this.add(row.row, key, 'invalid_phone');
    return phone;
  }

  email(row: SheetRow): string | null {
    const value = cell(row, 'email');
    if (value !== null && !EMAIL.test(value)) {
      this.add(row.row, 'email', 'invalid_email');
      return null;
    }
    return value;
  }

  /** VAT registration and TRN together (decisions 0010, 0037). */
  vat(row: SheetRow): { registered: boolean; trn: string | null } {
    const registered = this.yesNo(row, 'vat_registered', false) ?? false;
    const value = cell(row, 'trn');
    if (!registered) {
      if (value !== null) this.add(row.row, 'trn', 'trn_needs_registration');
      return { registered, trn: null };
    }
    if (value === null) {
      this.add(row.row, 'trn', 'required');
      return { registered, trn: null };
    }
    const trn = normalizeTrn(value);
    if (!trn) this.add(row.row, 'trn', 'invalid_trn');
    return { registered, trn };
  }

  code(row: SheetRow): string | null {
    const value = cell(row, 'code');
    if (value === null) return null;
    const code = normalizeCode(value);
    if (!CODE_PATTERN.test(code)) {
      this.add(row.row, 'code', 'invalid_code');
      return null;
    }
    return code;
  }

  barcode(row: SheetRow): string | null {
    const value = cell(row, 'barcode');
    if (value === null) return null;
    if (!BARCODE_PATTERN.test(value)) {
      this.add(row.row, 'barcode', 'invalid');
      return null;
    }
    return value;
  }

  choice<T>(row: SheetRow, key: string, choices: Readonly<Record<string, T>>): T | null {
    const value = cell(row, key);
    if (value === null) return null;
    const found = choices[simplify(value)];
    if (found === undefined) this.add(row.row, key, 'invalid_choice');
    return found ?? null;
  }

  /** Marks values that appear more than once in the file. */
  uniqueInFile(rows: readonly { row: number; value: string | null }[], key: string): void {
    const seen = new Map<string, number>();
    for (const { row, value } of rows) {
      if (value === null) continue;
      const k = value.toUpperCase();
      if (seen.has(k)) this.add(row, key, 'duplicate_in_file');
      else seen.set(k, row);
    }
  }
}

export { CUSTOMER_TYPES, ITEM_TYPES };

/** Reference data looked up by code (lower case), for items. */
export interface ItemReferences {
  categories: Map<string, { id: bigint; active: boolean; code: string }>;
  units: Map<string, { id: bigint; active: boolean; decimals: number }>;
  vat: Map<string, { id: bigint }>;
  businessLines: Map<string, { id: bigint; active: boolean }>;
  existingCodes: Set<string>;
  activeBarcodes: Set<string>;
}

export async function itemReferences(db: Kysely<DB>): Promise<ItemReferences> {
  const [categories, units, vat, lines, codes, barcodes] = await Promise.all([
    db.selectFrom('md.item_categories').select(['id', 'code', 'is_active']).execute(),
    db.selectFrom('md.units').select(['id', 'code', 'is_active', 'decimals']).execute(),
    db.selectFrom('md.vat_categories').select(['id', 'code']).execute(),
    db.selectFrom('md.business_lines').select(['id', 'code', 'is_active']).execute(),
    db.selectFrom('md.items').select('code').execute(),
    db.selectFrom('md.item_barcodes').select('barcode').where('is_active', '=', true).execute(),
  ]);
  return {
    categories: new Map(
      categories.map((c) => [
        c.code.toLowerCase(),
        { id: c.id, active: c.is_active, code: c.code },
      ]),
    ),
    units: new Map(
      units.map((u) => [
        u.code.toLowerCase(),
        { id: u.id, active: u.is_active, decimals: u.decimals },
      ]),
    ),
    vat: new Map(vat.map((v) => [v.code.toLowerCase(), { id: v.id }])),
    businessLines: new Map(
      lines.map((l) => [l.code.toLowerCase(), { id: l.id, active: l.is_active }]),
    ),
    existingCodes: new Set(codes.map((c) => c.code.toUpperCase())),
    activeBarcodes: new Set(barcodes.map((b) => b.barcode.toUpperCase())),
  };
}
