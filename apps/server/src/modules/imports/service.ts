/**
 * Excel import (decision 0031): Check reads the whole file and saves nothing but the check
 * record; Import works only for a checked file without problems that has not changed since,
 * checks it again, and saves every row in ONE transaction, or none.
 */
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { format4dp, formatFils, nextCode, quantityToDb } from '@artepool/shared';
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
import { createAdjustment, type Auth } from '../inventory/service';

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
  opening_stock: ['stock.opening'],
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
  purchaseCost4dp: bigint | null;
  isSellable: boolean;
  descriptionAr: string | null;
  descriptionEn: string | null;
  moreBarcodes: { barcode: string; qtyPerScanMilli: bigint }[];
  packAr: string | null;
  packEn: string | null;
  reorderQty: bigint | null;
}

async function checkItems(
  db: Kysely<DB>,
  rows: SheetRow[],
  c: Checker,
  canCost: boolean,
): Promise<ItemRecord[]> {
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
    // Purchase price (decision 0038): without VAT; the owner only (kits are not imported).
    const purchaseCost = c.price(row, 'purchase_price');
    if (cell(row, 'purchase_price') !== null && !canCost) {
      c.add(row.row, 'purchase_price', 'cost_needs_permission');
    }
    const barcode = c.barcode(row);
    if (barcode && refs.activeBarcodes.has(barcode.toUpperCase()))
      c.add(row.row, 'barcode', 'already_exists');
    const reorderLevel = c.quantity(row, 'reorder_level', unit?.decimals ?? null);
    if (reorderLevel !== null && itemType !== null && itemType !== 'stock') {
      c.add(row.row, 'reorder_level', 'stock_fields_for_stock_only');
    }
    const reorderQty = c.quantity(row, 'reorder_qty', unit?.decimals ?? null);
    if (reorderQty === 0n) c.add(row.row, 'reorder_qty', 'invalid_quantity');
    if (reorderQty !== null && itemType !== null && itemType !== 'stock') {
      c.add(row.row, 'reorder_qty', 'stock_fields_for_stock_only');
    }
    const more = c.moreBarcodes(row, unit?.decimals ?? null);
    for (const b of more) {
      if (refs.activeBarcodes.has(b.barcode.toUpperCase()))
        c.add(row.row, 'more_barcodes', 'already_exists');
    }
    codes.push({ row: row.row, value: code });
    barcodes.push({ row: row.row, value: barcode });
    for (const b of more) barcodes.push({ row: row.row, value: b.barcode });
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
      purchaseCost4dp: purchaseCost,
      isSellable,
      descriptionAr: cell(row, 'description_ar'),
      descriptionEn: cell(row, 'description_en'),
      moreBarcodes: more,
      packAr: cell(row, 'pack_ar'),
      packEn: cell(row, 'pack_en'),
      reorderQty,
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

interface OpeningRecord {
  row: number;
  itemId: bigint;
  quantityMilli: bigint;
  unitCost4dp: bigint | null;
}

/** Opening stock: existing stock items, a quantity in the unit's decimals, a cost or a purchase price. */
async function checkOpening(
  db: Kysely<DB>,
  rows: SheetRow[],
  c: Checker,
): Promise<OpeningRecord[]> {
  const items = await db
    .selectFrom('md.items as i')
    .innerJoin('md.units as u', 'u.id', 'i.unit_id')
    .select([
      'i.id',
      'i.code',
      'i.item_type',
      'i.is_active',
      'i.fallback_unit_cost_4dp',
      'u.decimals',
    ])
    .execute();
  const byCode = new Map(items.map((i) => [i.code.toUpperCase(), i]));
  const out: OpeningRecord[] = [];
  const codes: { row: number; value: string | null }[] = [];
  for (const row of rows) {
    c.basics(row);
    const code = c.code(row);
    const item = code ? byCode.get(code) : undefined;
    if (code && !item) c.add(row.row, 'code', 'unknown_reference');
    else if (item && !item.is_active) c.add(row.row, 'code', 'inactive_reference');
    else if (item && item.item_type !== 'stock') c.add(row.row, 'code', 'not_a_stock_item');
    const quantity = c.quantity(row, 'quantity', item?.decimals ?? null);
    if (quantity === 0n) c.add(row.row, 'quantity', 'invalid_quantity');
    const cost = c.price(row, 'unit_cost');
    if (cell(row, 'unit_cost') === null && item && item.fallback_unit_cost_4dp === null) {
      c.add(row.row, 'unit_cost', 'cost_unknown');
    }
    codes.push({ row: row.row, value: code });
    if (c.isBad(row.row) || !item || quantity === null) continue;
    out.push({ row: row.row, itemId: item.id, quantityMilli: quantity, unitCost4dp: cost });
  }
  c.uniqueInFile(codes, 'code');
  return out.filter((r) => !c.isBad(r.row));
}

/** One opening adjustment for the whole file, posted with its journal entry. */
async function saveOpening(
  trx: Transaction<DB>,
  auth: Auth,
  batchId: bigint,
  records: OpeningRecord[],
): Promise<void> {
  const reason = await trx
    .selectFrom('sys.reason_codes')
    .select('id')
    .where('category', '=', 'other')
    .where('code', '=', 'OPENING')
    .executeTakeFirstOrThrow();
  for (const part of chunks(records)) {
    await createAdjustment(
      trx,
      auth,
      {
        kind: 'opening',
        reasonCodeId: reason.id.toString(),
        lines: part.map((r) => ({
          itemId: r.itemId.toString(),
          quantityMilli: r.quantityMilli.toString(),
          ...(r.unitCost4dp !== null ? { unitCost4dp: r.unitCost4dp.toString() } : {}),
        })),
      },
      batchId,
    );
  }
}

type Records = ItemRecord[] | PriceRecord[] | CustomerRecord[] | SupplierRecord[] | OpeningRecord[];

async function checkFile(
  db: Kysely<DB>,
  entity: ImportEntity,
  file: Buffer,
  canCost: boolean,
): Promise<{ rows: SheetRow[]; checker: Checker; records: Records }> {
  const rows = await rowsOf(entity, file);
  const checker = new Checker(entity);
  const records =
    entity === 'items'
      ? await checkItems(db, rows, checker, canCost)
      : entity === 'item_prices'
        ? await checkPrices(db, rows, checker)
        : entity === 'customers'
          ? await checkCustomers(db, rows, checker)
          : entity === 'opening_stock'
            ? await checkOpening(db, rows, checker)
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
  canCost: boolean,
): Promise<ImportCheckResponse> {
  const file = decode(body);
  const { rows, checker } = await checkFile(trx, entity, file, canCost);
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

async function standardLevel(trx: Kysely<DB>): Promise<bigint> {
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
            reorder_qty: r.reorderQty === null ? null : quantityToDb(r.reorderQty),
            fallback_unit_cost_4dp: r.purchaseCost4dp,
            is_sellable: r.isSellable,
            pack_ar: r.packAr,
            pack_en: r.packEn,
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
    const more = part.flatMap((r) =>
      r.moreBarcodes.map((b) => ({ itemId: idOf.get(r.code!)!, ...b })),
    );
    if (more.length > 0) {
      await trx
        .insertInto('md.item_barcodes')
        .values(
          more.map((b) =>
            stamped('md.item_barcodes', {
              item_id: b.itemId,
              barcode: b.barcode,
              qty_per_scan: quantityToDb(b.qtyPerScanMilli),
              is_primary: false,
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
  canCost: boolean,
  auth: Auth = null,
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
  const { checker, records } = await checkFile(trx, entity, file, canCost);
  if (checker.issues.length > 0) {
    throw ruleError('IMPORT_HAS_ERRORS', 'The file has problems now', {
      issuesTotal: checker.issues.length,
    });
  }
  if (entity === 'items') await saveItems(trx, records as ItemRecord[]);
  else if (entity === 'item_prices') await savePrices(trx, records as PriceRecord[]);
  else if (entity === 'customers') await saveCustomers(trx, records as CustomerRecord[]);
  else if (entity === 'opening_stock')
    await saveOpening(trx, auth, batchId, records as OpeningRecord[]);
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
  // The walk-in customer is made by every database itself (and has no phone to import).
  const rows = await db
    .selectFrom('md.customers')
    .selectAll()
    .where('is_walk_in', '=', false)
    .orderBy('code')
    .execute();
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

/** A number for a person to read and the import to read back: trailing zeros dropped. */
const plain = (text: string, keep = 0): string => {
  if (!text.includes('.')) return text;
  const [whole, fraction] = text.split('.') as [string, string];
  const trimmed = fraction.replace(/0+$/, '').padEnd(keep, '0');
  return trimmed ? `${whole}.${trimmed}` : whole;
};

/**
 * Every active item as an Excel file in the import's own columns (M7 part E, decision 0119): it
 * goes straight back in, e.g. into the clean database at go-live. Purchase prices only for
 * someone allowed to see them (0038). Kits cannot be imported: they are listed on their own sheet,
 * with their parts, to be made again by hand. Permission `data.export`; the export is audited.
 */
export async function exportItems(
  db: Kysely<DB>,
  canCost: boolean,
): Promise<{ file: FilePayload; rows: number }> {
  const level = await standardLevel(db);
  const items = await db
    .selectFrom('md.items as i')
    .innerJoin('md.item_categories as c', 'c.id', 'i.category_id')
    .innerJoin('md.units as u', 'u.id', 'i.unit_id')
    .innerJoin('md.vat_categories as v', 'v.id', 'i.vat_category_id')
    .leftJoin('md.business_lines as l', 'l.id', 'i.default_business_line_id')
    .leftJoin('md.item_prices as p', (join) =>
      join.onRef('p.item_id', '=', 'i.id').on('p.price_level_id', '=', level),
    )
    .select([
      'i.id',
      'i.code',
      'i.item_type',
      'i.name_ar',
      'i.name_en',
      'c.code as category',
      'u.code as unit',
      'v.code as vat',
      'p.price_4dp',
      'p.includes_vat',
      'i.fallback_unit_cost_4dp',
      sql<string | null>`i.reorder_level::text`.as('reorder_level'),
      sql<string | null>`i.reorder_qty::text`.as('reorder_qty'),
      'i.is_sellable',
      'l.code as business_line',
      'i.description_ar',
      'i.description_en',
      'i.pack_ar',
      'i.pack_en',
    ])
    .where('i.is_active', '=', true)
    .orderBy('i.code')
    .execute();
  const barcodes = await db
    .selectFrom('md.item_barcodes')
    .select(['item_id', 'barcode', 'is_primary', sql<string>`qty_per_scan::text`.as('qty')])
    .where('is_active', '=', true)
    .orderBy('item_id')
    .orderBy('is_primary', 'desc')
    .orderBy('id')
    .execute();
  const byItem = new Map<bigint, typeof barcodes>();
  for (const b of barcodes) byItem.set(b.item_id, [...(byItem.get(b.item_id) ?? []), b]);
  const components = await db
    .selectFrom('md.bundle_components as k')
    .innerJoin('md.items as ci', 'ci.id', 'k.component_item_id')
    .select(['k.bundle_item_id', 'ci.code', sql<string>`k.quantity::text`.as('qty')])
    .orderBy('ci.code')
    .execute();

  const price = (p: bigint | null) => (p === null ? null : plain(format4dp(p), 2));
  const yes = (b: boolean | null) => (b === null ? null : b ? 'yes' : 'no');
  const columns = COLUMNS.items.filter((c) => canCost || c.key !== 'purchase_price');
  const importable = items.filter((i) => i.item_type !== 'bundle');
  const kits = items.filter((i) => i.item_type === 'bundle');
  const file = await writeWorkbook([
    {
      name: 'Items',
      columns,
      textColumns: TEXT_COLUMNS,
      rows: importable.map((i) => {
        const codes = byItem.get(i.id) ?? [];
        const primary = codes.find((b) => b.is_primary) ?? null;
        const more = codes
          .filter((b) => b !== primary)
          .map((b) => (plain(b.qty) === '1' ? b.barcode : `${b.barcode}*${plain(b.qty)}`));
        const values: Record<string, string | number | null> = {
          code: i.code,
          type: i.item_type,
          name_ar: i.name_ar,
          name_en: i.name_en,
          category: i.category,
          unit: i.unit,
          vat: i.vat,
          price: price(i.price_4dp),
          price_includes_vat: yes(i.includes_vat),
          purchase_price: price(i.fallback_unit_cost_4dp),
          barcode: primary?.barcode ?? null,
          reorder_level: i.reorder_level === null ? null : plain(i.reorder_level),
          sellable: yes(i.is_sellable),
          business_line: i.business_line,
          description_ar: i.description_ar,
          description_en: i.description_en,
          more_barcodes: more.length > 0 ? more.join(' ') : null,
          pack_ar: i.pack_ar,
          pack_en: i.pack_en,
          reorder_qty: i.reorder_qty === null ? null : plain(i.reorder_qty),
        };
        return columns.map((c) => values[c.key] ?? null);
      }),
    },
    {
      name: 'Kits',
      columns: [
        { key: 'code', ar: 'الكود', en: 'Code' },
        { key: 'name_ar', ar: 'الاسم بالعربية', en: 'Arabic name' },
        { key: 'name_en', ar: 'الاسم بالإنجليزية', en: 'English name' },
        { key: 'price', ar: 'سعر البيع', en: 'Sale price' },
        { key: 'price_includes_vat', ar: 'السعر شامل الضريبة', en: 'Price includes VAT' },
        {
          key: 'parts',
          ar: 'المكونات (كود×كمية) — تتعمل باليد',
          en: 'Parts (code×quantity) — made by hand',
        },
      ],
      textColumns: ['code'],
      rows: kits.map((k) => [
        k.code,
        k.name_ar,
        k.name_en,
        price(k.price_4dp),
        yes(k.includes_vat),
        components
          .filter((c) => c.bundle_item_id === k.id)
          .map((c) => `${c.code}×${plain(c.qty)}`)
          .join(' '),
      ]),
    },
  ]);
  return {
    rows: items.length,
    file: { fileName: 'artepool-items.xlsx', mime: XLSX_MIME, dataBase64: file.toString('base64') },
  };
}

/** Every active supplier in the import's own columns (M7 part E); audited by the caller. */
export async function exportSuppliers(
  db: Kysely<DB>,
): Promise<{ file: FilePayload; rows: number }> {
  const rows = await db
    .selectFrom('md.suppliers')
    .selectAll()
    .where('is_active', '=', true)
    .orderBy('code')
    .execute();
  const file = await writeWorkbook([
    {
      name: 'Suppliers',
      columns: [{ key: 'code', ar: 'الكود', en: 'Code' }, ...COLUMNS.suppliers],
      textColumns: TEXT_COLUMNS,
      rows: rows.map((r) => [
        r.code,
        r.name,
        r.name_alt,
        r.phone,
        r.email,
        r.address_line,
        r.city,
        r.emirate,
        r.country_code,
        r.is_vat_registered ? 'yes' : 'no',
        r.trn,
        r.payment_terms_days,
        r.notes,
      ]),
    },
  ]);
  return {
    rows: rows.length,
    file: {
      fileName: 'artepool-suppliers.xlsx',
      mime: XLSX_MIME,
      dataBase64: file.toString('base64'),
    },
  };
}
