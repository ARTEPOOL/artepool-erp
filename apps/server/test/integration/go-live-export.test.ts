/**
 * Go-live from a clean database (M7 part E, decision 0119): the items, customers and suppliers
 * exported from one server go straight back into a new, empty one through the normal import
 * (check, then all rows in one transaction), and come back the same: codes, names, categories,
 * units, VAT, prices, purchase prices, every barcode (with how many a scan counts), sale packs,
 * reorder figures, lines of business; customers' types, phones, TRN and addresses; suppliers'
 * details. Inactive items stay behind; kits are listed with their parts to be made by hand.
 * Purchase prices go only to someone allowed to see them; every export is in the audit log.
 */
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  FilePayload,
  ImportCheckResponse,
  ImportCommitResponse,
} from '@artepool/shared/contracts';
import {
  addDevice,
  addOwner,
  addUser,
  call,
  openSession,
  startTestServer,
  type TestServer,
} from '../support/server';

type Actor = (method: 'GET' | 'POST', url: string, body?: unknown) => Promise<unknown>;

let shop: TestServer;
let clean: TestServer;
let oldOwner: Actor;
let newOwner: Actor;
let accountant: Actor;

async function actorOn(server: TestServer, roles: string[] | 'owner'): Promise<Actor> {
  const pc = await addDevice(server, { code: `OFFICE-${randomUUID().slice(0, 6)}` });
  const userId =
    roles === 'owner'
      ? await addOwner(server)
      : await addUser(server, { username: `u.${randomUUID().slice(0, 6)}`, roles });
  const token = (
    await openSession(server, {
      userId,
      deviceId: pc.id,
      ...(roles === 'owner' ? { method: 'password_totp' as const } : {}),
    })
  ).token;
  return async (method, url, body) => {
    const r = await call(server, method, url, {
      device: pc,
      token,
      ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }),
      ...(body !== undefined ? { body } : {}),
    });
    if (r.statusCode >= 400) throw new Error(`${method} ${url}: ${r.statusCode} ${r.body}`);
    return r.json();
  };
}

async function ref(server: TestServer, sqlText: string): Promise<string> {
  return (await server.admin.query<{ id: string }>(sqlText)).rows[0]!.id;
}

beforeAll(async () => {
  [shop, clean] = await Promise.all([startTestServer(), startTestServer()]);
  oldOwner = await actorOn(shop, 'owner');
  newOwner = await actorOn(clean, 'owner');
  accountant = await actorOn(shop, ['accountant']);
  const id = {
    chem: await ref(shop, `SELECT id::text FROM md.item_categories WHERE code = 'CHEM'`),
    serv: await ref(shop, `SELECT id::text FROM md.item_categories WHERE code = 'SERV'`),
    pcs: await ref(shop, `SELECT id::text FROM md.units WHERE code = 'PCS'`),
    kg: await ref(shop, `SELECT id::text FROM md.units WHERE code = 'KG'`),
    visit: await ref(shop, `SELECT id::text FROM md.units WHERE code = 'VISIT'`),
    sr: await ref(shop, `SELECT id::text FROM md.vat_categories WHERE code = 'SR'`),
    zr: await ref(shop, `SELECT id::text FROM md.vat_categories WHERE code = 'ZR'`),
    maintenance: await ref(
      shop,
      `SELECT id::text FROM md.business_lines WHERE code = 'maintenance'`,
    ),
  };
  const base = { categoryId: id.chem, unitId: id.pcs, vatCategoryId: id.sr };
  await oldOwner('POST', '/api/v1/items', {
    ...base,
    code: 'CHEM-0001',
    itemType: 'stock',
    nameAr: 'كلور حبيبات',
    nameEn: 'Chlorine granules',
    descriptionAr: 'دلو 10 كجم',
    descriptionEn: '10 kg bucket',
    packAr: 'دلو',
    packEn: 'Bucket',
    defaultBusinessLineId: id.maintenance,
    reorderLevelMilli: '5000',
    reorderQtyMilli: '20000',
    purchaseCost4dp: '1500000',
    price: { price4dp: '1890000', includesVat: true },
    barcodes: [
      { barcode: '6291041500213', isPrimary: true },
      { barcode: '6291041500220', qtyPerScanMilli: '6000' },
      { barcode: 'CHL-10' },
    ],
  });
  await oldOwner('POST', '/api/v1/items', {
    ...base,
    code: 'CHEM-0002',
    itemType: 'stock',
    unitId: id.kg,
    vatCategoryId: id.zr,
    nameAr: 'ملح سائب',
    nameEn: 'Loose salt',
    reorderLevelMilli: '12500',
    price: { price4dp: '12500', includesVat: false },
  });
  await oldOwner('POST', '/api/v1/items', {
    code: 'SERV-0001',
    itemType: 'service',
    categoryId: id.serv,
    unitId: id.visit,
    vatCategoryId: id.sr,
    nameAr: 'زيارة صيانة',
    nameEn: 'Maintenance visit',
    price: { price4dp: '2500000', includesVat: true },
  });
  const old = (await oldOwner('POST', '/api/v1/items', {
    ...base,
    code: 'CHEM-0003',
    itemType: 'stock',
    nameAr: 'صنف قديم',
    nameEn: 'Old item',
    price: { price4dp: '10000', includesVat: true },
  })) as { id: string; rowVersion: number };
  await oldOwner('POST', `/api/v1/items/${old.id}/deactivate`, {
    reason: 'No longer sold',
    rowVersion: old.rowVersion,
  });
  await oldOwner('POST', '/api/v1/items', {
    ...base,
    code: 'CHEM-0004',
    itemType: 'bundle',
    nameAr: 'طقم بداية الموسم',
    nameEn: 'Season start kit',
    price: { price4dp: '3000000', includesVat: true },
    components: [
      {
        itemId: await ref(shop, `SELECT id::text FROM md.items WHERE code = 'CHEM-0001'`),
        quantityMilli: '2000',
      },
    ],
  });
  await oldOwner('POST', '/api/v1/customers', {
    customerType: 'company',
    name: 'Oasis Pools LLC',
    nameAlt: 'واحة المسابح ذ.م.م',
    phone: '050 123 4567',
    email: 'accounts@oasis.example',
    addressLine: 'Sanaiya, Street 5',
    area: 'Sanaiya',
    city: 'Al Ain',
    emirate: 'abu_dhabi',
    isVatRegistered: true,
    trn: '100234567890003',
    notes: 'Pays by cheque',
  });
  await oldOwner('POST', '/api/v1/customers', {
    customerType: 'individual',
    name: 'أحمد سالم',
    phone: '0501112233',
    isVatRegistered: false,
  });
  await oldOwner('POST', '/api/v1/suppliers', {
    name: 'Gulf Pool Supplies',
    nameAlt: 'الخليج لمستلزمات المسابح',
    phone: '04 555 1234',
    email: 'sales@gulf.example',
    addressLine: 'Al Quoz 3',
    city: 'Dubai',
    emirate: 'dubai',
    countryCode: 'AE',
    isVatRegistered: true,
    trn: '100345678900003',
    paymentTermsDays: 30,
    notes: 'Delivers Tuesdays',
  });
});
afterAll(async () => {
  await Promise.all([shop.close(), clean.close()]);
});

const items = (server: TestServer) =>
  sql<Record<string, unknown>>`
    SELECT i.code, i.item_type, i.name_ar, i.name_en, c.code AS category, u.code AS unit,
           v.code AS vat, p.price_4dp::text AS price, p.includes_vat, i.fallback_unit_cost_4dp::text AS cost,
           i.reorder_level::text AS reorder_level, i.reorder_qty::text AS reorder_qty, i.is_sellable,
           l.code AS line, i.description_ar, i.description_en, i.pack_ar, i.pack_en,
           (SELECT string_agg(b.barcode || ':' || b.qty_per_scan::text || ':' || b.is_primary, ' ' ORDER BY b.barcode)
              FROM md.item_barcodes b WHERE b.item_id = i.id AND b.is_active) AS barcodes
      FROM md.items i
      JOIN md.item_categories c ON c.id = i.category_id
      JOIN md.units u ON u.id = i.unit_id
      JOIN md.vat_categories v ON v.id = i.vat_category_id
      LEFT JOIN md.business_lines l ON l.id = i.default_business_line_id
      LEFT JOIN md.item_prices p ON p.item_id = i.id
     WHERE i.is_active AND i.item_type <> 'bundle'
     ORDER BY i.code`
    .execute(server.db)
    .then((r) => r.rows);

async function importInto(entity: string, file: FilePayload): Promise<ImportCommitResponse> {
  const body = { fileName: file.fileName, dataBase64: file.dataBase64 };
  const checked = (await newOwner(
    'POST',
    `/api/v1/imports/${entity}/check`,
    body,
  )) as ImportCheckResponse;
  expect(checked.issues).toEqual([]);
  expect(checked.status).toBe('validated');
  return (await newOwner(
    'POST',
    `/api/v1/imports/${entity}/${checked.batchId}/commit`,
    body,
  )) as ImportCommitResponse;
}

async function sheetRows(file: FilePayload, name: string): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(file.dataBase64, 'base64') as unknown as ArrayBuffer);
  const rows: string[][] = [];
  workbook.getWorksheet(name)!.eachRow((row) => {
    rows.push(
      (row.values as (string | number | boolean | null | undefined)[])
        .slice(1)
        .map((v) => (v === null || v === undefined ? '' : String(v))),
    );
  });
  return rows;
}

describe('the export for go-live', () => {
  it('items come back the same in a new, empty database; inactive items stay behind', async () => {
    const file = (await oldOwner('GET', '/api/v1/items/export')) as FilePayload;
    expect(file.fileName).toBe('artepool-items.xlsx');
    const imported = await importInto('items', file);
    expect(imported.imported).toBe(3);
    const before = await items(shop);
    const after = await items(clean);
    expect(after).toEqual(before);
    expect(after.map((i) => i.code)).toEqual(['CHEM-0001', 'CHEM-0002', 'SERV-0001']);
    expect(after[0]).toMatchObject({
      barcodes: '6291041500213:1.000:true 6291041500220:6.000:false CHL-10:1.000:false',
      pack_en: 'Bucket',
      reorder_qty: '20.000',
      line: 'maintenance',
      cost: '1500000',
    });
    // Kits are listed with their parts, to be made again by hand.
    const kits = await sheetRows(file, 'Kits');
    expect(kits[1]).toEqual([
      'CHEM-0004',
      'طقم بداية الموسم',
      'Season start kit',
      '300.00',
      'yes',
      'CHEM-0001×2',
    ]);
  });

  it('customers and suppliers come back the same', async () => {
    const customers = (await oldOwner('GET', '/api/v1/customers/export')) as FilePayload;
    expect((await importInto('customers', customers)).imported).toBeGreaterThanOrEqual(2);
    const suppliers = (await oldOwner('GET', '/api/v1/suppliers/export')) as FilePayload;
    expect((await importInto('suppliers', suppliers)).imported).toBe(1);
    const customerRows = (server: TestServer) =>
      sql<Record<string, unknown>>`
        SELECT customer_type, name, name_alt, phone, email, address_line, area, city, emirate,
               is_vat_registered, trn, notes
          FROM md.customers WHERE NOT is_walk_in ORDER BY name`
        .execute(server.db)
        .then((r) => r.rows);
    expect(await customerRows(clean)).toEqual(await customerRows(shop));
    const supplierRows = (server: TestServer) =>
      sql<Record<string, unknown>>`
        SELECT name, name_alt, phone, email, address_line, city, emirate, country_code,
               is_vat_registered, trn, payment_terms_days, notes
          FROM md.suppliers ORDER BY name`
        .execute(server.db)
        .then((r) => r.rows);
    expect(await supplierRows(clean)).toEqual(await supplierRows(shop));
  });

  it('the import checks the extra barcodes, the sale pack and the reorder quantity', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Data');
    sheet.addRow([
      'Type',
      'Arabic name',
      'English name',
      'Category',
      'Unit',
      'Sale price',
      'Price includes VAT',
      'More barcodes',
      'Sale pack (Arabic)',
      'Reorder quantity',
    ]);
    sheet.addRow(['stock', 'أ', 'A', 'CHEM', 'PCS', '5', 'yes', '6291041500213', 'علبة', '2']); // already in use
    sheet.addRow(['stock', 'ب', 'B', 'CHEM', 'PCS', '5', 'yes', '6299999999994*1.5', null, null]); // PCS: whole pieces
    sheet.addRow(['stock', 'ج', 'C', 'CHEM', 'PCS', '5', 'yes', 'not a barcode!', null, null]);
    sheet.addRow(['service', 'د', 'D', 'SERV', 'VISIT', '5', 'yes', null, 'x'.repeat(41), '3']);
    const dataBase64 = Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
    const checked = (await oldOwner('POST', '/api/v1/imports/items/check', {
      fileName: 'items.xlsx',
      dataBase64,
    })) as ImportCheckResponse;
    expect(checked.status).toBe('rejected');
    expect(checked.issues.map((i) => [i.row, i.column?.split(' / ')[1], i.problem])).toEqual(
      expect.arrayContaining([
        [2, 'More barcodes', 'already_exists'],
        [3, 'More barcodes', 'invalid_quantity'],
        [4, 'More barcodes', 'invalid'],
        [5, 'Sale pack (Arabic)', 'too_long'],
        [5, 'Reorder quantity', 'stock_fields_for_stock_only'],
      ]),
    );
  });

  it('purchase prices only for those allowed to see them; every export is audited', async () => {
    const file = (await accountant('GET', '/api/v1/items/export')) as FilePayload;
    const header = (await sheetRows(file, 'Items'))[0]!;
    expect(header.some((h) => h.includes('Purchase price'))).toBe(false);
    expect(header.some((h) => h.includes('More barcodes'))).toBe(true);
    const { rows } = await shop.admin.query<{ entity: string }>(
      `SELECT new_values ->> 'entity' AS entity FROM audit.log WHERE action = 'event:data.exported'`,
    );
    expect(rows.map((r) => r.entity)).toEqual(
      expect.arrayContaining(['items', 'customers', 'suppliers']),
    );
  });
});
