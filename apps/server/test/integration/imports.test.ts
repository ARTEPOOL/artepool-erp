/**
 * M2 T8: Excel import (decision 0031). Check reads the whole file and lists every problem by row
 * and column; Import saves all rows in one transaction or none, only for the checked file.
 */
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
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
  type TestDevice,
  type TestServer,
} from '../support/server';

type Method = 'GET' | 'POST';
type Actor = (method: Method, url: string, body?: unknown) => ReturnType<typeof call>;

let server: TestServer;
let owner: Actor;
let cashier: Actor;

function actor(device: TestDevice, token: string): Actor {
  return (method, url, body) =>
    call(server, method, url, {
      device,
      token,
      ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }),
      ...(body !== undefined ? { body } : {}),
    });
}

async function refusal(response: ReturnType<typeof call>) {
  const r = await response;
  const body = r.json<{ error: { code: string; details: Record<string, unknown> } }>();
  return { status: r.statusCode, code: body.error?.code, ...body.error?.details };
}

/** An Excel file with a header row and data rows, the way a person fills a template. */
async function excel(rows: (string | number | null)[][]): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
}

const count = async (table: string): Promise<number> =>
  (await server.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

beforeAll(async () => {
  server = await startTestServer();
  const office = await addDevice(server, { code: 'OFFICE-01' });
  const ownerId = await addOwner(server);
  owner = actor(
    office,
    (await openSession(server, { userId: ownerId, deviceId: office.id, method: 'password_totp' }))
      .token,
  );
  const pc = await addDevice(server, { code: 'COUNTER-PC' });
  const cashierId = await addUser(server, { username: 'cash.imp', roles: ['cashier'] });
  cashier = actor(pc, (await openSession(server, { userId: cashierId, deviceId: pc.id })).token);
});
afterAll(() => server.close());

const ITEM_HEADER = [
  'الكود / Code',
  'Type',
  'الاسم بالعربية',
  'English name',
  'Category',
  'Unit',
  'VAT category',
  'Sale price',
  'Price includes VAT',
  'Barcode',
  'Reorder level',
];

const goodItems = [
  [
    'CHEM-0001',
    'stock',
    'كلور حبيبات',
    'Chlorine granules',
    'CHEM',
    'KG',
    'SR',
    '45.5',
    'yes',
    '6290000000017',
    '10.5',
  ],
  [null, 'مخزني', 'مضخة أرضية', 'Floor pump', 'EQUIP', 'PCS', null, 1250, 'نعم', null, '2'],
  [null, 'خدمة', 'تنظيف المسبح', 'Pool cleaning', 'SERV', 'VISIT', 'SR', '150', 'no', null, null],
];

describe('templates', () => {
  it('come with Arabic/English headers and the allowed values, for data.import only', async () => {
    expect((await cashier('GET', '/api/v1/imports/items/template')).statusCode).toBe(403);
    const file = (await owner('GET', '/api/v1/imports/items/template')).json<FilePayload>();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(file.dataBase64, 'base64') as unknown as ArrayBuffer);
    const headers = (workbook.getWorksheet('Data')!.getRow(1).values as string[]).filter(Boolean);
    expect(headers.slice(0, 3)).toEqual([
      'الكود / Code',
      'النوع / Type',
      'الاسم بالعربية / Arabic name',
    ]);
    expect(workbook.getWorksheet('Lists')!.rowCount).toBeGreaterThan(10);
  });
});

describe('importing items (all or nothing)', () => {
  let checked: ImportCheckResponse;
  let goodFile: string;

  it('reports every problem by row and column, and imports nothing', async () => {
    const before = await count('md.items');
    const file = await excel([
      ITEM_HEADER,
      ...goodItems,
      [
        'CHEM-0002',
        'stock',
        'كلور سائل',
        'Liquid chlorine',
        'NOPE',
        'L',
        'SR',
        '-3',
        null,
        '6290000000017',
        '1.5',
      ],
      ['CHEM-0001', 'bundle', null, 'Kit', 'CHEM', 'PCS', 'XX', null, null, null, '0.5'],
    ]);
    const report = (
      await owner('POST', '/api/v1/imports/items/check', {
        fileName: 'items.xlsx',
        dataBase64: file,
      })
    ).json<ImportCheckResponse>();
    expect(report).toMatchObject({
      status: 'rejected',
      rowsTotal: 5,
      rowsValid: 3,
      rowsInvalid: 2,
    });
    const problems = report.issues.map((i) => `${i.row}:${i.column}:${i.problem}`);
    expect(problems).toEqual(
      expect.arrayContaining([
        '5:التصنيف / Category:unknown_reference',
        '5:سعر البيع / Sale price:invalid_price',
        '5:الباركود / Barcode:duplicate_in_file',
        '6:الكود / Code:duplicate_in_file',
        '6:النوع / Type:invalid_choice',
        '6:الاسم بالعربية / Arabic name:required',
        '6:فئة الضريبة / VAT category:unknown_reference',
        '6:سعر البيع / Sale price:price_required',
        '6:حد إعادة الطلب / Reorder level:too_many_decimals',
      ]),
    );
    expect(await count('md.items')).toBe(before);
    expect(
      await refusal(
        owner('POST', `/api/v1/imports/items/${report.batchId}/commit`, {
          fileName: 'items.xlsx',
          dataBase64: file,
        }),
      ),
    ).toMatchObject({ code: 'RULE_VIOLATION', rule: 'IMPORT_NOT_CHECKED' });
  });

  it('imports a clean file in one go, with prices, barcodes and suggested codes', async () => {
    goodFile = await excel([ITEM_HEADER, ...goodItems]);
    checked = (
      await owner('POST', '/api/v1/imports/items/check', {
        fileName: 'items.xlsx',
        dataBase64: goodFile,
      })
    ).json<ImportCheckResponse>();
    expect(checked).toMatchObject({ status: 'validated', rowsValid: 3, issues: [] });
    const changed = await excel([ITEM_HEADER, ...goodItems.slice(0, 2)]);
    expect(
      await refusal(
        owner('POST', `/api/v1/imports/items/${checked.batchId}/commit`, {
          fileName: 'items.xlsx',
          dataBase64: changed,
        }),
      ),
    ).toMatchObject({ code: 'RULE_VIOLATION', rule: 'IMPORT_FILE_CHANGED' });
    const done = (
      await owner('POST', `/api/v1/imports/items/${checked.batchId}/commit`, {
        fileName: 'items.xlsx',
        dataBase64: goodFile,
      })
    ).json<ImportCommitResponse>();
    expect(done.imported).toBe(3);
    const { rows } = await server.admin.query(
      `SELECT i.code, p.price_4dp::text AS price, p.includes_vat, b.barcode, i.reorder_level::text AS reorder
         FROM md.items i
         LEFT JOIN md.item_prices p ON p.item_id = i.id
         LEFT JOIN md.item_barcodes b ON b.item_id = i.id
        ORDER BY i.code`,
    );
    expect(rows).toEqual([
      {
        code: 'CHEM-0001',
        price: '455000',
        includes_vat: true,
        barcode: '6290000000017',
        reorder: '10.500',
      },
      {
        code: 'EQUIP-0001',
        price: '12500000',
        includes_vat: true,
        barcode: null,
        reorder: '2.000',
      },
      { code: 'SERV-0001', price: '1500000', includes_vat: false, barcode: null, reorder: null },
    ]);
  });

  it('never imports the same file twice', async () => {
    expect(
      await refusal(
        owner('POST', `/api/v1/imports/items/${checked.batchId}/commit`, {
          fileName: 'items.xlsx',
          dataBase64: goodFile,
        }),
      ),
    ).toMatchObject({ code: 'RULE_VIOLATION', rule: 'IMPORT_NOT_CHECKED' });
    const again = (
      await owner('POST', '/api/v1/imports/items/check', {
        fileName: 'items.xlsx',
        dataBase64: goodFile,
      })
    ).json<ImportCheckResponse>();
    expect(again.status).toBe('rejected');
    expect(again.issues.map((i) => i.problem)).toEqual(['already_exists', 'already_exists']);
  });

  it('refuses files that are not Excel', async () => {
    expect(
      await refusal(
        owner('POST', '/api/v1/imports/items/check', {
          fileName: 'x.xlsx',
          dataBase64: Buffer.from('hello').toString('base64'),
        }),
      ),
    ).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      issues: [{ path: ['file'], code: 'not_excel' }],
    });
  });
});

describe('importing customers and prices', () => {
  it('normalises phones and TRNs, and checks duplicates against the database', async () => {
    const file = await excel([
      ['Type', 'Name', 'Phone', 'VAT-registered', 'TRN', 'Emirate'],
      ['فرد', 'أحمد علي', 501234567, 'no', null, 'العين'],
      ['شركة', 'Al Ain Resort', '03 765 4321', 'نعم', '100-123-456-789-012', 'أبوظبي'],
      ['contractor', 'Builder', '0507654321', 'yes', null, 'Dubai'],
    ]);
    const report = (
      await owner('POST', '/api/v1/imports/customers/check', {
        fileName: 'c.xlsx',
        dataBase64: file,
      })
    ).json<ImportCheckResponse>();
    expect(report.issues.map((i) => `${i.row}:${i.problem}`)).toEqual([
      '2:invalid_choice',
      '4:required',
    ]);
    const fixed = await excel([
      ['Type', 'Name', 'Phone', 'VAT-registered', 'TRN', 'Emirate'],
      ['فرد', 'أحمد علي', 501234567, 'no', null, null],
      ['شركة', 'Al Ain Resort', '03 765 4321', 'نعم', '100-123-456-789-012', 'أبوظبي'],
    ]);
    const ok = (
      await owner('POST', '/api/v1/imports/customers/check', {
        fileName: 'c.xlsx',
        dataBase64: fixed,
      })
    ).json<ImportCheckResponse>();
    expect(ok.status).toBe('validated');
    await owner('POST', `/api/v1/imports/customers/${ok.batchId}/commit`, {
      fileName: 'c.xlsx',
      dataBase64: fixed,
    });
    const { rows } = await server.admin.query(
      `SELECT phone, trn, credit_mode, emirate FROM md.customers WHERE NOT is_walk_in ORDER BY phone`,
    );
    expect(rows).toEqual([
      { phone: '+97137654321', trn: '100123456789012', credit_mode: 'cash', emirate: 'abu_dhabi' },
      { phone: '+971501234567', trn: null, credit_mode: 'cash', emirate: null },
    ]);
  });

  it('updates the prices of existing items', async () => {
    const file = await excel([
      ['Code', 'Sale price', 'Price includes VAT'],
      ['chem-0001', '47.25', 'yes'],
      ['NOPE-1', '1', 'yes'],
    ]);
    const report = (
      await owner('POST', '/api/v1/imports/item_prices/check', {
        fileName: 'p.xlsx',
        dataBase64: file,
      })
    ).json<ImportCheckResponse>();
    expect(report.issues.map((i) => `${i.row}:${i.problem}`)).toEqual(['3:unknown_reference']);
    const fixed = await excel([
      ['Code', 'Sale price', 'Price includes VAT'],
      ['chem-0001', '47.25', 'yes'],
    ]);
    const ok = (
      await owner('POST', '/api/v1/imports/item_prices/check', {
        fileName: 'p.xlsx',
        dataBase64: fixed,
      })
    ).json<ImportCheckResponse>();
    await owner('POST', `/api/v1/imports/item_prices/${ok.batchId}/commit`, {
      fileName: 'p.xlsx',
      dataBase64: fixed,
    });
    const { rows } = await server.admin.query(
      `SELECT p.price_4dp::text AS price FROM md.item_prices p JOIN md.items i ON i.id = p.item_id WHERE i.code = 'CHEM-0001'`,
    );
    expect(rows).toEqual([{ price: '472500' }]);
  });

  it('handles 5,000 rows in one transaction', async () => {
    const rows: (string | number | null)[][] = [['Type', 'Name', 'Phone']];
    for (let i = 0; i < 5000; i++) {
      rows.push(['individual', `Customer ${i}`, `05${String(60_000_000 + i).padStart(8, '0')}`]);
    }
    const file = await excel(rows);
    const started = Date.now();
    const ok = (
      await owner('POST', '/api/v1/imports/customers/check', {
        fileName: 'big.xlsx',
        dataBase64: file,
      })
    ).json<ImportCheckResponse>();
    expect(ok).toMatchObject({ status: 'validated', rowsTotal: 5000 });
    const done = (
      await owner('POST', `/api/v1/imports/customers/${ok.batchId}/commit`, {
        fileName: 'big.xlsx',
        dataBase64: file,
      })
    ).json<ImportCommitResponse>();
    expect(done.imported).toBe(5000);
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 120_000);
});
