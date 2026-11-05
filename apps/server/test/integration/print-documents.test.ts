/**
 * Every A4 document the shop prints, made by the real sales engine and printed by the real
 * renderer: simplified and full tax invoices, a credit note, a debit note, an advance payment
 * invoice, the final invoice that deducts it, a receipt, a quotation and a statement.
 *
 * Each must carry its required fields (number, dates, seller and customer, the lines and the
 * totals; a note's original invoice, its date and the reason), first in the HTML and then in the
 * PDF itself: the accountant pack once had a credit note whose PDF was printed before its fonts
 * had loaded, so it showed headings and empty boxes only (decision 0018 review, 2026-11-04).
 * The PDF's text is read with pdftotext (poppler-utils, installed in CI).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CustomerDetail,
  DocumentDetail,
  ItemDetail,
  QuotationDetail,
  ReceivePaymentResponse,
} from '@artepool/shared/contracts';
import {
  documentHtml,
  quotationHtml,
  receiptHtml,
  statementHtml,
} from '../../src/modules/printing/service';
import { closeRenderer, renderPdf } from '../../src/modules/printing/render';
import {
  addDevice,
  addOwner,
  call,
  openSession,
  startTestServer,
  type TestServer,
} from '../support/server';

// The PDF renderer uses the pinned browser; locally the one the screen tests use.
if (process.env.ARTEPOOL_E2E_CHROMIUM)
  process.env.ARTEPOOL_CHROMIUM ??= process.env.ARTEPOOL_E2E_CHROMIUM;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
let server: TestServer;
let owner: (method: Method, url: string, body?: unknown) => ReturnType<typeof call>;
const ids: Record<string, string> = {};
const work = mkdtempSync(join(tmpdir(), 'artepool-print-'));

async function ok<T>(response: ReturnType<typeof call>, status = 200): Promise<T> {
  const r = await response;
  if (r.statusCode !== status) throw new Error(`${r.statusCode}: ${r.body}`);
  return r.json<T>();
}

/**
 * What a person sees in the HTML: no styles, no tags, entities decoded once, spaces collapsed.
 * `&amp;` is decoded last, so "&amp;lt;" stays the text "&lt;".
 */
function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

let pdftotext: string | null = null;
try {
  execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
  pdftotext = 'pdftotext';
} catch {
  if (process.env.CI) throw new Error('pdftotext (poppler-utils) is needed for this test in CI');
}

/** The PDF's own text (pdftotext), or null where the tool is missing on a developer's PC. */
async function pdfText(name: string, html: string): Promise<{ text: string | null; pdf: string }> {
  const pdf = await renderPdf(html);
  const file = join(work, `${name}.pdf`);
  writeFileSync(file, pdf);
  const text = pdftotext
    ? execFileSync(pdftotext, ['-layout', file, '-'], { encoding: 'utf8' })
    : null;
  return { text, pdf: pdf.toString('latin1') };
}

const today = new Date().toISOString().slice(0, 10);
const printedDate = `${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)}`;
/**
 * What each printed document must show. `pairs`: a label and its own value, side by side in the
 * HTML (in the PDF the value sits beside the Arabic label, so there both are looked for apart).
 */
const printed: Record<
  string,
  { html: string; must: string[]; mustNot?: string[]; pairs?: [string, string][] }
> = {};

beforeAll(async () => {
  server = await startTestServer();
  const office = await addDevice(server, { code: 'OFFICE-01' });
  const ownerId = await addOwner(server);
  const token = (
    await openSession(server, { userId: ownerId, deviceId: office.id, method: 'password_totp' })
  ).token;
  owner = (method, url, body) =>
    call(server, method, url, {
      device: office,
      token,
      ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }),
      ...(body !== undefined ? { body } : {}),
    });
  const { rows } = await sql<{ kind: string; id: string }>`
    SELECT 'category' AS kind, id::text FROM md.item_categories WHERE code = 'PARTS'
    UNION ALL SELECT 'pcs', id::text FROM md.units WHERE code = 'PCS'
    UNION ALL SELECT 'visit', id::text FROM md.units WHERE code = 'VISIT'
    UNION ALL SELECT 'vat', id::text FROM md.vat_categories WHERE code = 'SR'
    UNION ALL SELECT 'construction', id::text FROM md.business_lines WHERE code = 'construction'
    UNION ALL SELECT 'opening', id::text FROM sys.reason_codes WHERE category = 'other' AND code = 'OPENING'
    UNION ALL SELECT 'cnReturn', id::text FROM sys.reason_codes WHERE category = 'credit_note' AND code = 'RETURN'
    UNION ALL SELECT 'dnPrice', id::text FROM sys.reason_codes WHERE category = 'debit_note' AND code = 'PRICE_ADJ'
    UNION ALL SELECT 'cash', id::text FROM md.payment_methods WHERE kind = 'cash' AND is_active ORDER BY 1 LIMIT 100
  `.execute(server.db);
  for (const r of rows) ids[r.kind] ??= r.id;
  await ok(
    owner('PUT', '/api/v1/company', {
      legalNameAr: 'آرتيبول لحمامات السباحة',
      legalNameEn: 'ARTEPOOL Swimming Pools',
      vatRegistered: true,
      trn: '100123456789012',
      addressAr: 'العين، أبوظبي',
      addressEn: 'Al Ain, Abu Dhabi',
    }),
  );

  const item = async (
    code: string,
    type: 'stock' | 'service',
    nameEn: string,
    price4dp: string,
    includesVat: boolean,
    opening?: [string, string],
  ) => {
    const it = await ok<ItemDetail>(
      owner('POST', '/api/v1/items', {
        code,
        itemType: type,
        nameAr: `صنف ${code}`,
        nameEn,
        categoryId: ids.category,
        unitId: type === 'stock' ? ids.pcs : ids.visit,
        vatCategoryId: ids.vat,
        price: { price4dp, includesVat },
      }),
      201,
    );
    if (opening)
      await ok(
        owner('POST', '/api/v1/stock/adjustments', {
          kind: 'opening',
          reasonCodeId: ids.opening,
          lines: [{ itemId: it.id, quantityMilli: opening[0], unitCost4dp: opening[1] }],
        }),
        201,
      );
    return it;
  };
  const customer = async (body: Record<string, unknown>, credit: string) => {
    const c = await ok<CustomerDetail>(owner('POST', '/api/v1/customers', body), 201);
    await ok(
      owner('POST', `/api/v1/customers/${c.id}/credit`, {
        credit: { mode: 'credit', creditLimitFils: credit, paymentTermsDays: 30 },
        reason: 'Print test',
        rowVersion: c.rowVersion,
      }),
    );
    return c.id;
  };
  const issue = (doc: DocumentDetail, extra: Record<string, unknown> = {}) =>
    ok<DocumentDetail>(
      owner('POST', `/api/v1/sales/documents/${doc.id}/issue`, {
        rowVersion: doc.rowVersion,
        ...extra,
      }),
    );

  const chlorine = await item('CHL-25', 'stock', 'Chlorine tablets 25 kg', '1890000', true, [
    '20000',
    '1200000',
  ]);
  const test = await item('TEST-W', 'service', 'Pool water test', '500000', false);
  const pump = await item('PUMP-15', 'stock', 'Pool pump 1.5 HP', '12500000', false, [
    '5000',
    '9000000',
  ]);
  const sand = await item('SAND-25', 'stock', 'Filter sand 25 kg', '350000', false, [
    '50000',
    '200000',
  ]);
  const pool = await item(
    'POOL-BUILD',
    'service',
    'Pool construction 10 x 5 m',
    '1000000000',
    false,
  );

  // A simplified tax invoice: the walk-in customer, an item whose price includes VAT.
  const walkIn = (
    await sql<{ id: string }>`SELECT id::text FROM md.customers WHERE is_walk_in`.execute(server.db)
  ).rows[0]!.id;
  const a = await ok<DocumentDetail>(
    owner('POST', '/api/v1/sales/invoices', {
      customerId: walkIn,
      lines: [
        { itemId: chlorine.id, quantityMilli: '2000' },
        { itemId: test.id, quantityMilli: '1000' },
      ],
    }),
    201,
  );
  const aIssued = await issue(a, {
    payments: [{ paymentMethodId: ids.cash, amountFils: a.totalFils }],
  });
  printed.simplified = {
    html: (await documentHtml(server.db, BigInt(aIssued.id))).html,
    must: [
      aIssued.docNumber!,
      'Simplified Tax Invoice',
      'Chlorine tablets 25 kg',
      'Pool water test',
      '180.00',
      '360.00',
      '18.00',
      '410.00',
      '20.50',
      '430.50',
    ],
    // The unit price is printed excluding VAT, like the taxable amount beside it.
    mustNot: ['189.00'],
  };

  // A full tax invoice: a VAT-registered company on credit, a line discount.
  const waha = await customer(
    {
      customerType: 'company',
      name: 'Al Waha Contracting',
      phone: '050 1112233',
      isVatRegistered: true,
      trn: '100987654321003',
      addressLine: 'Industrial Area 1, Al Ain',
    },
    '5000000',
  );
  const b = await issue(
    await ok<DocumentDetail>(
      owner('POST', '/api/v1/sales/invoices', {
        customerId: waha,
        lines: [
          { itemId: pump.id, quantityMilli: '1000' },
          { itemId: sand.id, quantityMilli: '10000', lineDiscountFils: '3500' },
        ],
      }),
      201,
    ),
  );
  printed.full = {
    html: (await documentHtml(server.db, BigInt(b.id))).html,
    must: [
      b.docNumber!,
      'Tax Invoice',
      'Al Waha Contracting',
      '100987654321003',
      'Industrial Area 1, Al Ain',
      'Pool pump 1.5 HP',
      'Filter sand 25 kg',
      '1,250.00',
      '35.00',
      '1,565.00',
      '78.25',
      '1,643.25',
    ],
  };
  const sandLine = b.lines.find((l) => l.itemId === sand.id)!;
  const pumpLine = b.lines.find((l) => l.itemId === pump.id)!;

  // A credit note: two bags back; the original invoice, its date and the reason are required.
  const cn = await ok<DocumentDetail>(
    owner('POST', '/api/v1/sales/notes', {
      kind: 'credit_note',
      originalDocumentId: b.id,
      reasonCodeId: ids.cnReturn,
      reasonText: 'Two bags returned unopened',
      lines: [
        { originalLineId: sandLine.id, quantityMilli: '2000', returnStockStatus: 'available' },
      ],
    }),
    201,
  );
  printed.creditNote = {
    html: (await documentHtml(server.db, BigInt(cn.id))).html,
    must: [
      cn.docNumber!,
      'Tax Credit Note',
      'Original invoice',
      b.docNumber!,
      'Original invoice date',
      'Two bags returned unopened',
      'Al Waha Contracting',
      '100987654321003',
      'Filter sand 25 kg',
      '63.00',
      '3.15',
      '66.15',
    ],
    // The reference a tax credit/debit note needs: the original invoice's number and its date.
    pairs: [
      ['Original invoice', b.docNumber!],
      ['Original invoice date', printedDate],
    ],
  };

  // A debit note: 5.00 more on the pump; the same references are required.
  const dn = await ok<DocumentDetail>(
    owner('POST', '/api/v1/sales/notes', {
      kind: 'debit_note',
      originalDocumentId: b.id,
      reasonCodeId: ids.dnPrice,
      reasonText: 'Price correction on the pump',
      lines: [{ originalLineId: pumpLine.id, quantityMilli: '1000', unitPrice4dp: '50000' }],
    }),
    201,
  );
  printed.debitNote = {
    html: (await documentHtml(server.db, BigInt(dn.id))).html,
    must: [
      dn.docNumber!,
      'Tax Debit Note',
      'Original invoice',
      b.docNumber!,
      'Original invoice date',
      'Price correction on the pump',
      'Pool pump 1.5 HP',
      '5.00',
      '0.25',
      '5.25',
    ],
    // The reference a tax credit/debit note needs: the original invoice's number and its date.
    pairs: [
      ['Original invoice', b.docNumber!],
      ['Original invoice date', printedDate],
    ],
  };

  // A receipt that settles part of the full invoice.
  const receipt = await ok<ReceivePaymentResponse>(
    owner('POST', '/api/v1/sales/payments', {
      customerId: waha,
      part: { paymentMethodId: ids.cash, amountFils: '50000' },
    }),
    201,
  );
  printed.receipt = {
    html: (await receiptHtml(server.db, BigInt(receipt.payment.id))).html,
    must: [receipt.payment.docNumber, 'Receipt', 'Al Waha Contracting', '500.00', b.docNumber!],
  };

  // A quotation, an advance payment invoice against it, and the final invoice that deducts it.
  const villa = await customer(
    {
      customerType: 'individual',
      name: 'Ahmed Mohammed villa',
      phone: '050 4445566',
      isVatRegistered: false,
      addressLine: 'Al Jimi, Al Ain',
    },
    '10000000',
  );
  const q = await ok<QuotationDetail>(
    owner('POST', '/api/v1/sales/quotations', {
      customerId: villa,
      businessLineId: ids.construction,
      subject: 'Swimming pool 10 x 5 m',
      lines: [{ itemId: pool.id, quantityMilli: '1000' }],
    }),
    201,
  );
  const sent = await ok<QuotationDetail>(
    owner('POST', `/api/v1/sales/quotations/${q.id}/action`, {
      action: 'send',
      rowVersion: q.rowVersion,
    }),
  );
  printed.quotation = {
    html: (await quotationHtml(server.db, BigInt(q.id))).html,
    must: [
      q.docNumber,
      'Quotation',
      'Ahmed Mohammed villa',
      'Swimming pool 10 x 5 m',
      'Pool construction 10 x 5 m',
      '100,000.00',
      '5,000.00',
      '105,000.00',
    ],
  };
  const paid = await ok<ReceivePaymentResponse>(
    owner('POST', '/api/v1/sales/payments', {
      customerId: villa,
      part: { paymentMethodId: ids.cash, amountFils: '3150000' },
      asAdvance: true,
      quotationId: q.id,
    }),
    201,
  );
  const advance = paid.advanceInvoice!;
  printed.advance = {
    html: (await documentHtml(server.db, BigInt(advance.id))).html,
    must: [
      advance.docNumber!,
      'Payment Received',
      'Ahmed Mohammed villa',
      q.docNumber,
      '30,000.00',
      '1,500.00',
      '31,500.00',
    ],
  };
  const draftFinal = await ok<DocumentDetail>(
    owner('POST', `/api/v1/sales/quotations/${q.id}/convert`, { rowVersion: sent.rowVersion }),
    201,
  );
  const final = await issue(
    await ok<DocumentDetail>(
      owner('PUT', `/api/v1/sales/invoices/${draftFinal.id}`, {
        customerId: villa,
        quotationId: q.id,
        businessLineId: ids.construction,
        lines: [{ itemId: pool.id, quantityMilli: '1000' }],
        deductions: [{ advanceDocumentId: advance.id }],
        rowVersion: draftFinal.rowVersion,
      }),
    ),
  );
  printed.final = {
    html: (await documentHtml(server.db, BigInt(final.id))).html,
    must: [
      final.docNumber!,
      'Tax Invoice',
      'Ahmed Mohammed villa',
      'Al Jimi, Al Ain',
      `Less: payment ${advance.docNumber!}`,
      '-30,000.00',
      '-1,500.00',
      '70,000.00',
      '3,500.00',
      '73,500.00',
    ],
  };
  // The deduction's unit price is its net, like the taxable amount beside it: -30,000.00 twice on
  // its line (unit price, taxable amount), while -31,500.00 is only the total of earlier payments.
  printed.final.must.push('-30,000.00 0.00 -30,000.00');

  // The statement of the company's account: the invoice, both notes and the receipt.
  printed.statement = {
    html: await statementHtml(server.db, BigInt(waha), today, today),
    must: [
      'Statement of Account',
      'Al Waha Contracting',
      b.docNumber!,
      cn.docNumber!,
      dn.docNumber!,
      receipt.payment.docNumber,
    ],
  };
}, 180_000);

afterAll(async () => {
  await closeRenderer();
  await server.close();
  rmSync(work, { recursive: true, force: true });
});

const KINDS = [
  'simplified',
  'full',
  'creditNote',
  'debitNote',
  'advance',
  'final',
  'receipt',
  'quotation',
  'statement',
];
/** The seller's name on everything; its TRN on the tax documents (receipts and statements are not). */
const NOT_TAX = new Set(['receipt', 'quotation', 'statement']);
const seller = (kind: string) =>
  NOT_TAX.has(kind) ? ['ARTEPOOL Swimming Pools'] : ['ARTEPOOL Swimming Pools', '100123456789012'];

describe('every printed document carries its required fields', () => {
  it.each(KINDS)('%s: in the HTML', (kind) => {
    const { html, must, mustNot = [], pairs = [] } = printed[kind]!;
    const text = visibleText(html);
    for (const field of [...seller(kind), printedDate, ...must])
      expect(text, field).toContain(field);
    for (const [label, value] of pairs) expect(text, label).toContain(`${label} ${value}`);
    for (const field of mustNot) expect(text, field).not.toContain(field);
  });

  it.each(KINDS)(
    '%s: in the PDF itself (text drawn, fonts embedded)',
    async (kind) => {
      const { html, must, pairs = [] } = printed[kind]!;
      const { text, pdf } = await pdfText(kind, html);
      // The body font carries the numbers, the names and the amounts: without it the page is empty.
      expect(pdf).toMatch(/IBMPlexSansArabic-Regular/);
      expect(pdf).toMatch(/IBMPlexSansArabic-Bold/);
      if (text === null) return; // No pdftotext on this PC (CI always has it).
      const flat = text.replace(/\s+/g, ' ');
      for (const field of [
        ...seller(kind),
        printedDate,
        ...[...must, ...pairs.flat()].filter((f) => /^[\x20-\x7e]+$/.test(f)),
      ]) {
        expect(flat, field).toContain(field);
      }
    },
    60_000,
  );
});
