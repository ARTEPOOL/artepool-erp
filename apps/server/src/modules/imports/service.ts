/**
 * Excel import (decision 0031): Check reads the whole file and saves nothing but the check
 * record; Import works only for a checked file without problems that has not changed since,
 * checks it again, and saves every row in ONE transaction, or none.
 */
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { formatFils, nextCode, quantityToDb } from '@artepool/shared';
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  type CustomerType,
  type Emirate,
  type FilePayload,
  type ImportCheckResponse,
  type ImportCommitResponse,
  type ImportEntity,
  type ImportFileRequest,
  type ImportIssue,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { AppError, ruleError } from '../../platform/errors/app-error';
import {
  Checker,
  COLUMNS,
  CUSTOMER_TYPES,
  ITEM_TYPES,
  itemReferences,
  TEXT_COLUMNS,
} from './entities';
import { cell, ExcelFileError, readRows, writeWorkbook, type SheetRow } from './xlsx';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const REPORT_LIMIT = 1000;
const CHUNK = 500;
/** The database gives customers and suppliers the next free code (C00001…, S00001…). */
const NEXT_CODE = sql<string>`NULL`;

/** The permission each import needs on top of `data.import`. */
export const IMPORT_PERMISSIONS: Readonly<Record<ImportEntity, readonly string[]>> = {
  items: ['items.manage', 'prices.manage'],
  item_prices: ['prices.manage'],
  customers: ['customers.manage'],
  suppliers: ['suppliers.manage'],
};

function decode(body: ImportFileRequest): Buffer {
  const file = Buffer.from(body.dataBase64, 'base64');
  if (file.length === 0) throw fileProblem('empty');
  if (file.length > IMPORT_MAX_BYTES) throw fileProblem('too_large');
  return file;
}

function fileProblem(problem: string): AppError {
  return new AppError('VALIDATION_FAILED', `Import file refused: ${problem}`, {
    part: 'file',
    issues: [{ path: ['file'], code: problem }],
  });
}

async function rowsOf(entity: ImportEntity, file: Buffer): Promise<SheetRow[]> {
  try {
    return await readRows(file, COLUMNS[entity], IMPORT_MAX_ROWS);
  } catch (error) {
    if (error instanceof ExcelFileError) throw fileProblem(error.problem);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Checking: every row becomes a record or a list of problems
// ---------------------------------------------------------------------------------------------

interface ItemRecord {
  row: number;
  code: string | null;
  itemType: 'stock' | 'service';
  nameAr: string;
  nameEn: string;
  categoryId: bigint;
  categoryCode: string;
  unitId: bigint;
  vatCategoryId: bigint;
  businessLineId: bigint | null;
  price4dp: bigint | null;
  includesVat: boolean | null;
  barcode: string | null;
  reorderLevel: bigint | null;
  isSellable: boolean;
  descriptionAr: string | null;
  descriptionEn: string | null;
}

async function checkItems(db: Kysely<DB>, rows: SheetRow[], c: Checker): Promise<ItemRecord[]> {
  const refs = await itemReferences(db);
  const out: ItemRecord[] = [];
  const codes: { row: number; value: string | null }[] = [];
  const barcodes: { row: number; value: string | null }[] = [];
  for (const row of rows) {
    c.basics(row);
    const code = c.code(row);
    if (code && refs.existingCodes.has(code)) c.add(row.row, 'code', 'already_exists');
    const itemType = c.choice(row, 'type', ITEM_TYPES);
    const lookup = <T extends { id: bigint; active?: boolean }>(
      key: string,
      map: Map<string, T>,
    ): T | null => {
      const value = cell(row, key);
      if (value === null) return null;
      const found = map.get(value.trim().toLowerCase());
      if (!found) c.add(row.row, key, 'unknown_reference');
      else if (found.active === false) c.add(row.row, key, 'inactive_reference');
      return found ?? null;
    };
    const category = lookup('category', refs.categories);
    const unit = lookup('unit', refs.units);
    const vat = cell(row, 'vat') === null ? refs.vat.get('sr')! : lookup('vat', refs.vat);
    const line = lookup('business_line', refs.businessLines);
    const price = c.price(row, 'price');
    const includesVat = c.yesNo(row, 'price_includes_vat', null);
    const isSellable = c.yesNo(row, 'sellable', true) ?? true;
    if (isSellable && cell(row, 'price') !== null && price === 0n)
      c.add(row.row, 'price', 'price_required');
    if (isSellable && cell(row, 'price') === null) c.add(row.row, 'price', 'price_required');
    if (cell(row, 'price') !== null && cell(row, 'price_includes_vat') === null)
      c.add(row.row, 'price_includes_vat', 'required');
    const barcode = c.barcode(row);
    if (barcode && refs.activeBarcodes.has(barcode.toUpperCase()))
      c.add(row.row, 'barcode', 'already_exists');
    const reorderLevel = c.quantity(row, 'reorder_level', unit?.decimals ?? null);
    if (reorderLevel !== null && itemType !== null && itemType !== 'stock') {
      c.add(row.row, 'reorder_level', 'stock_fields_for_stock_only');
    }
    codes.push({ row: row.row, value: code });
    barcodes.push({ row: row.row, value: barcode });
    if (c.isBad(row.row) || !itemType || !category || !unit || !vat) continue;
    out.push({
      row: row.row,
      code,
      itemType,
      nameAr: cell(row, 'name_ar')!,
      nameEn: cell(row, 'name_en')!,
      categoryId: category.id,
      categoryCode: category.code,
      unitId: unit.id,
      vatCategoryId: vat.id,
      businessLineId: line?.id ?? null,
      price4dp: price,
      includesVat,
      barcode,
      reorderLevel,
      isSellable,
      descriptionAr: cell(row, 'description_ar'),
      descriptionEn: cell(row, 'description_en'),
    });
  }
  c.uniqueInFile(codes, 'code');
  c.uniqueInFile(barcodes, 'barcode');
  return out.filter((r) => !c.isBad(r.row));
}

interface PriceRecord {
  row: number;
  itemId: bigint;
  price4dp: bigint;
  includesVat: boolean;
}

async function checkPrices(db: Kysely<DB>, rows: SheetRow[], c: Checker): Promise<PriceRecord[]> {
  const items = await db.selectFrom('md.items').select(['id', 'code']).execute();
  const byCode = new Map(items.map((i) => [i.code.toUpperCase(), i.id]));
  const out: PriceRecord[] = [];
  const codes: { row: number; value: string | null }[] = [];
  for (const row of rows) {
    c.basics(row);
    const code = c.code(row);
    const itemId = code ? byCode.get(code) : undefined;
    if (code && itemId === undefined) c.add(row.row, 'code', 'unknown_reference');
    const price = c.price(row, 'price');
    if (price === 0n) c.add(row.row, 'price', 'price_required');
    const includesVat = c.yesNo(row, 'price_includes_vat', null);
    codes.push({ row: row.row, value: code });
    if (c.isBad(row.row) || itemId === undefined || price === null || includesVat === null)
      continue;
    out.push({ row: row.row, itemId, price4dp: price, includesVat });
  }
  c.uniqueInFile(codes, 'code');
  return out.filter((r) => !c.isBad(r.row));
}

interface CustomerRecord {
  row: number;
  customerType: CustomerType;
  name: string;
  nameAlt: string | null;
  phone: string;
  phoneAlt: string | null;
  email: string | null;
  address: string | null;
  area: string | null;
  city: string | null;
  emirate: Emirate | null;
  registered: boolean;
  trn: string | null;
  notes: string | null;
}

async function checkCustomers(
  db: Kysely<DB>,
  rows: SheetRow[],
  c: Checker,
): Promise<CustomerRecord[]> {
  const existing = await db.selectFrom('md.customers').select(['phone', 'trn']).execute();
  const phones = new Set(existing.map((e) => e.phone).filter((p): p is string => p !== null));
  const trns = new Set(existing.map((e) => e.trn).filter((t): t is string => t !== null));
  const out: CustomerRecord[] = [];
  const filePhones: { row: number; value: string | null }[] = [];
  const fileTrns: { row: number; value: string | null }[] = [];
  for (const row of rows) {
    c.basics(row);
    const customerType = c.choice(row, 'type', CUSTOMER_TYPES);
    const phone = c.phone(row, 'phone');
    if (phone && phones.has(phone)) c.add(row.row, 'phone', 'already_exists');
    const phoneAlt = c.phone(row, 'phone_alt');
    const email = c.email(row);
    const emirate = c.emirate(row);
    const { registered, trn } = c.vat(row);
    if (trn && trns.has(trn)) c.add(row.row, 'trn', 'already_exists');
    filePhones.push({ row: row.row, value: phone });
    fileTrns.push({ row: row.row, value: trn });
    if (c.isBad(row.row) || !customerType || !phone) continue;
    out.push({
      row: row.row,
      customerType,
      name: cell(row, 'name')!,
      nameAlt: cell(row, 'name_alt'),
      phone,
      phoneAlt,
      email,
      address: cell(row, 'address'),
      area: cell(row, 'area'),
      city: cell(row, 'city'),
      emirate,
      registered,
      trn,
      notes: cell(row, 'notes'),
    });
  }
  c.uniqueInFile(filePhones, 'phone');
  c.uniqueInFile(fileTrns, 'trn');
  return out.filter((r) => !c.isBad(r.row));
}

interface SupplierRecord {
  row: number;
  name: string;
  nameAlt: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  emirate: Emirate | null;
  country: string;
  registered: boolean;
  trn: string | null;
  terms: number;
  notes: string | null;
}

async function checkSuppliers(
  db: Kysely<DB>,
  rows: SheetRow[],
  c: Checker,
): Promise<SupplierRecord[]> {
  const existing = await db.selectFrom('md.suppliers').select('trn').execute();
  const trns = new Set(existing.map((e) => e.trn).filter((t): t is string => t !== null));
  const out: SupplierRecord[] = [];
  const fileTrns: { row: number; value: string | null }[] = [];
  for (const row of rows) {
    c.basics(row);
    const phone = c.phone(row, 'phone');
    const email = c.email(row);
    const emirate = c.emirate(row);
    const country = (cell(row, 'country') ?? 'AE').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) c.add(row.row, 'country', 'invalid');
    let terms = 0;
    if (cell(row, 'payment_terms_days') !== null) {
      terms = Number(cell(row, 'payment_terms_days'));
      if (!Number.isInteger(terms) || terms < 0 || terms > 365) {
        c.add(row.row, 'payment_terms_days', 'invalid_number');
      }
    }
    const { registered, trn } = c.vat(row);
    if (trn && trns.has(trn)) c.add(row.row, 'trn', 'already_exists');
    fileTrns.push({ row: row.row, value: trn });
    if (c.isBad(row.row)) continue;
    out.push({
      row: row.row,
      name: cell(row, 'name')!,
      nameAlt: cell(row, 'name_alt'),
      phone,
      email,
      address: cell(row, 'address'),
      city: cell(row, 'city'),
      emirate,
      country,
      registered,
      trn,
      terms,
      notes: cell(row, 'notes'),
    });
  }
  c.uniqueInFile(fileTrns, 'trn');
  return out.filter((r) => !c.isBad(r.row));
}

type Records = ItemRecord[] | PriceRecord[] | CustomerRecord[] | SupplierRecord[];

async function checkFile(
  db: Kysely<DB>,
  entity: ImportEntity,
  file: Buffer,
): Promise<{ rows: SheetRow[]; checker: Checker; records: Records }> {
  const rows = await rowsOf(entity, file);
  const checker = new Checker(entity);
  const records =
    entity === 'items'
      ? await checkItems(db, rows, checker)
      : entity === 'item_prices'
        ? await checkPrices(db, rows, checker)
        : entity === 'customers'
          ? await checkCustomers(db, rows, checker)
          : await checkSuppliers(db, rows, checker);
  checker.issues.sort((a, b) => a.row - b.row);
  return { rows, checker, records };
}

const sha256 = (file: Buffer) => createHash('sha256').update(file).digest();

/** Step 1: check the whole file; nothing but the check record is saved. */
export async function checkImport(
  trx: Transaction<DB>,
  entity: ImportEntity,
  body: ImportFileRequest,
): Promise<ImportCheckResponse> {
  const file = decode(body);
  const { rows, checker } = await checkFile(trx, entity, file);
  const issues: ImportIssue[] = checker.issues.slice(0, REPORT_LIMIT);
  const status = checker.issues.length === 0 ? 'validated' : 'rejected';
  const batch = await trx
    .insertInto('sys.import_batches')
    .values(
      stamped('sys.import_batches', {
        entity,
        file_name: body.fileName,
        file_sha256: sha256(file),
        status,
        rows_total: rows.length,
        rows_valid: rows.length - checker.invalidRows,
        rows_invalid: checker.invalidRows,
        error_report: JSON.stringify({ issues, total: checker.issues.length }),
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return {
    batchId: batch.id.toString(),
    entity,
    status,
    rowsTotal: rows.length,
    rowsValid: rows.length - checker.invalidRows,
    rowsInvalid: checker.invalidRows,
    issues,
    issuesTotal: checker.issues.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Importing: one transaction, all rows or none
// ---------------------------------------------------------------------------------------------

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

async function standardLevel(trx: Transaction<DB>): Promise<bigint> {
  return (
    await trx
      .selectFrom('md.price_levels')
      .select('id')
      .where('is_default', '=', true)
      .executeTakeFirstOrThrow()
  ).id;
}

async function saveItems(trx: Transaction<DB>, records: ItemRecord[]): Promise<void> {
  const existing = (await trx.selectFrom('md.items').select('code').execute()).map((r) => r.code);
  const taken = [...existing, ...records.flatMap((r) => (r.code ? [r.code] : []))];
  for (const record of records) {
    if (record.code === null) {
      record.code = nextCode(record.categoryCode.toUpperCase(), taken);
      taken.push(record.code);
    }
  }
  const level = await standardLevel(trx);
  for (const part of chunks(records)) {
    const inserted = await trx
      .insertInto('md.items')
      .values(
        part.map((r) =>
          stamped('md.items', {
            code: r.code!,
            item_type: r.itemType,
            name_ar: r.nameAr,
            name_en: r.nameEn,
            description_ar: r.descriptionAr,
            description_en: r.descriptionEn,
            category_id: r.categoryId,
            unit_id: r.unitId,
            vat_category_id: r.vatCategoryId,
            default_business_line_id: r.businessLineId,
            reorder_level: r.reorderLevel === null ? null : quantityToDb(r.reorderLevel),
            is_sellable: r.isSellable,
          }),
        ),
      )
      .returning(['id', 'code'])
      .execute();
    const idOf = new Map(inserted.map((i) => [i.code, i.id]));
    const prices = part.filter((r) => r.price4dp !== null && r.includesVat !== null);
    if (prices.length > 0) {
      await trx
        .insertInto('md.item_prices')
        .values(
          prices.map((r) =>
            stamped('md.item_prices', {
              price_level_id: level,
              item_id: idOf.get(r.code!)!,
              price_4dp: r.price4dp!,
              includes_vat: r.includesVat!,
            }),
          ),
        )
        .execute();
    }
    const barcodes = part.filter((r) => r.barcode !== null);
    if (barcodes.length > 0) {
      await trx
        .insertInto('md.item_barcodes')
        .values(
          barcodes.map((r) =>
            stamped('md.item_barcodes', {
              item_id: idOf.get(r.code!)!,
              barcode: r.barcode!,
              is_primary: true,
            }),
          ),
        )
        .execute();
    }
  }
}

async function savePrices(trx: Transaction<DB>, records: PriceRecord[]): Promise<void> {
  const level = await standardLevel(trx);
  for (const r of records) {
    await trx
      .insertInto('md.item_prices')
      .values(
        stamped('md.item_prices', {
          price_level_id: level,
          item_id: r.itemId,
          price_4dp: r.price4dp,
          includes_vat: r.includesVat,
        }),
      )
      .onConflict((oc) =>
        oc
          .columns(['price_level_id', 'item_id'])
          .doUpdateSet({ price_4dp: r.price4dp, includes_vat: r.includesVat }),
      )
      .execute();
  }
}

async function saveCustomers(trx: Transaction<DB>, records: CustomerRecord[]): Promise<void> {
  for (const part of chunks(records)) {
    await trx
      .insertInto('md.customers')
      .values(
        part.map((r) =>
          stamped('md.customers', {
            code: NEXT_CODE,
            customer_type: r.customerType,
            name: r.name,
            name_alt: r.nameAlt,
            phone: r.phone,
            phone_alt: r.phoneAlt,
            email: r.email,
            address_line: r.address,
            area: r.area,
            city: r.city,
            emirate: r.emirate,
            is_vat_registered: r.registered,
            trn: r.trn,
            notes: r.notes,
          }),
        ),
      )
      .execute();
  }
}

async function saveSuppliers(trx: Transaction<DB>, records: SupplierRecord[]): Promise<void> {
  for (const part of chunks(records)) {
    await trx
      .insertInto('md.suppliers')
      .values(
        part.map((r) =>
          stamped('md.suppliers', {
            code: NEXT_CODE,
            name: r.name,
            name_alt: r.nameAlt,
            phone: r.phone,
            email: r.email,
            address_line: r.address,
            city: r.city,
            emirate: r.emirate,
            country_code: r.country,
            is_vat_registered: r.registered,
            trn: r.trn,
            payment_terms_days: r.terms,
            notes: r.notes,
          }),
        ),
      )
      .execute();
  }
}

/** Step 2: the same file, checked again inside the transaction, then every row saved. */
export async function commitImport(
  trx: Transaction<DB>,
  userId: bigint,
  entity: ImportEntity,
  batchId: bigint,
  body: ImportFileRequest,
): Promise<ImportCommitResponse> {
  const batch = await trx
    .selectFrom('sys.import_batches')
    .select(['id', 'entity', 'status', 'file_sha256'])
    .where('id', '=', batchId)
    .forUpdate()
    .executeTakeFirst();
  if (!batch || batch.entity !== entity) throw new AppError('NOT_FOUND', 'No such import check');
  if (batch.status !== 'validated') {
    throw ruleError('IMPORT_NOT_CHECKED', `Import ${batchId} is ${batch.status}`);
  }
  const file = decode(body);
  if (!sha256(file).equals(batch.file_sha256)) {
    throw ruleError('IMPORT_FILE_CHANGED', 'The file is not the one that was checked');
  }
  const { checker, records } = await checkFile(trx, entity, file);
  if (checker.issues.length > 0) {
    throw ruleError('IMPORT_HAS_ERRORS', 'The file has problems now', {
      issuesTotal: checker.issues.length,
    });
  }
  if (entity === 'items') await saveItems(trx, records as ItemRecord[]);
  else if (entity === 'item_prices') await savePrices(trx, records as PriceRecord[]);
  else if (entity === 'customers') await saveCustomers(trx, records as CustomerRecord[]);
  else await saveSuppliers(trx, records as SupplierRecord[]);
  await trx
    .updateTable('sys.import_batches')
    .set({ status: 'committed', committed_at: new Date(), committed_by: userId })
    .where('id', '=', batchId)
    .execute();
  return { batchId: batchId.toString(), imported: records.length };
}

// ---------------------------------------------------------------------------------------------
// Templates and exports
// ---------------------------------------------------------------------------------------------

/** An empty template with Arabic/English headers, and a sheet listing the allowed values. */
export async function template(db: Kysely<DB>, entity: ImportEntity): Promise<FilePayload> {
  const lists: (string | number | null)[][] = [];
  if (entity === 'items') {
    lists.push(['النوع / Type', 'stock, service / مخزني، خدمة']);
    for (const c of await db
      .selectFrom('md.item_categories')
      .select(['code', 'name_ar', 'name_en'])
      .where('is_active', '=', true)
      .orderBy('code')
      .execute()) {
      lists.push(['التصنيف / Category', `${c.code} — ${c.name_ar} / ${c.name_en}`]);
    }
    for (const u of await db
      .selectFrom('md.units')
      .select(['code', 'name_ar', 'name_en'])
      .where('is_active', '=', true)
      .orderBy('code')
      .execute()) {
      lists.push(['الوحدة / Unit', `${u.code} — ${u.name_ar} / ${u.name_en}`]);
    }
    for (const v of await db
      .selectFrom('md.vat_categories')
      .select(['code', 'name_ar', 'name_en'])
      .orderBy('id')
      .execute()) {
      lists.push(['فئة الضريبة / VAT category', `${v.code} — ${v.name_ar} / ${v.name_en}`]);
    }
    for (const l of await db
      .selectFrom('md.business_lines')
      .select(['code', 'name_ar', 'name_en'])
      .where('is_active', '=', true)
      .orderBy('sort_order')
      .execute()) {
      lists.push(['قسم العمل / Line of business', `${l.code} — ${l.name_ar} / ${l.name_en}`]);
    }
  }
  if (entity === 'customers') {
    lists.push(['النوع / Type', 'individual, contractor, company / فرد، مقاول، شركة']);
  }
  if (entity === 'customers' || entity === 'suppliers') {
    lists.push([
      'الإمارة / Emirate',
      'Abu Dhabi, Dubai, Sharjah, Ajman, Umm Al Quwain, Ras Al Khaimah, Fujairah',
    ]);
  }
  lists.push(['نعم / لا — Yes / No', 'yes, no / نعم، لا']);
  const file = await writeWorkbook([
    { name: 'Data', columns: COLUMNS[entity], textColumns: TEXT_COLUMNS },
    {
      name: 'Lists',
      columns: [
        { key: 'what', ar: 'العمود', en: 'Column' },
        { key: 'values', ar: 'القيم المسموحة', en: 'Allowed values' },
      ],
      rows: lists,
    },
  ]);
  return {
    fileName: `artepool-${entity.replace('_', '-')}-template.xlsx`,
    mime: XLSX_MIME,
    dataBase64: file.toString('base64'),
  };
}

/** Every customer as an Excel file (permission `data.export`; the export is audited). */
export async function exportCustomers(
  db: Kysely<DB>,
): Promise<{ file: FilePayload; rows: number }> {
  const rows = await db.selectFrom('md.customers').selectAll().orderBy('code').execute();
  const columns = [
    { key: 'code', ar: 'الكود', en: 'Code' },
    ...COLUMNS.customers,
    { key: 'credit_mode', ar: 'نقدي أو آجل', en: 'Cash or credit' },
    { key: 'credit_limit', ar: 'حد الائتمان', en: 'Credit limit' },
    { key: 'payment_terms_days', ar: 'أيام السداد', en: 'Payment terms (days)' },
    { key: 'active', ar: 'مفعّل', en: 'Active' },
  ];
  const file = await writeWorkbook([
    {
      name: 'Customers',
      columns,
      textColumns: TEXT_COLUMNS,
      rows: rows.map((r) => [
        r.code,
        r.customer_type,
        r.name,
        r.name_alt,
        r.phone,
        r.phone_alt,
        r.email,
        r.address_line,
        r.area,
        r.city,
        r.emirate,
        r.is_vat_registered ? 'yes' : 'no',
        r.trn,
        r.notes,
        r.credit_mode,
        formatFils(r.credit_limit_fils),
        r.payment_terms_days,
        r.is_active ? 'yes' : 'no',
      ]),
    },
  ]);
  return {
    rows: rows.length,
    file: {
      fileName: 'artepool-customers.xlsx',
      mime: XLSX_MIME,
      dataBase64: file.toString('base64'),
    },
  };
}
