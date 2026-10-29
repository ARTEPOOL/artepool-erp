/**
 * M4 T4–T8 through the API: invoices issued with their stock, cost and journal entry in one
 * transaction; the 0013 worked example from quotation to final invoice; payments settling the
 * oldest first with the rest as a payment invoice (0052); unpaid credit (0046); credit notes
 * returning goods to defective stock (0015); a bounced cheque (0048); opening balances and the
 * statement (0051). Line amounts from the database equal the shared helper's (property test).
 */
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeLine } from '@artepool/shared';
import type {
  CustomersResponse as CustomerList,
  DashboardResponse,
  CancelInvoiceResponse,
  CustomerBalance,
  CustomerDetail,
  DocumentDetail,
  DocumentsResponse,
  ItemDetail,
  ItemStockResponse,
  JournalEntryDetail,
  PaymentDetail,
  QuotationDetail,
  ReceivePaymentResponse,
  PaymentsResponse,
  StatementResponse,
  TrialBalanceResponse,
} from '@artepool/shared/contracts';
import { withBusinessTx } from '../../src/platform/db/tx';
import { documentHtml } from '../../src/modules/printing/service';
import { writeFileSync } from 'node:fs';
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

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
type Actor = (method: Method, url: string, body?: unknown) => ReturnType<typeof call>;

let server: TestServer;
let owner: Actor;
let accountant: Actor;
let cashier: Actor;
let storekeeper: Actor;
/** Issues and receives, but holds none of the approval permissions (discount, price, credit). */
let clerk: Actor;
let clerkId: bigint;
let clerkPc: TestDevice;
let accountantId: bigint;
let ownerId: bigint;
const ids: Record<string, string> = {};
let phone = 1_000_000;

function actor(device: TestDevice, token: string): Actor {
  return (method, url, body) =>
    call(server, method, url, {
      device,
      token,
      ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }),
      ...(body !== undefined ? { body } : {}),
    });
}

async function signedIn(username: string, roles: string[]) {
  const pc = await addDevice(server, { code: `PC-${username}` });
  const id = await addUser(server, { username, roles });
  return {
    act: actor(pc, (await openSession(server, { userId: id, deviceId: pc.id })).token),
    id,
    pc,
  };
}

async function refusal(response: ReturnType<typeof call>) {
  const r = await response;
  const body = r.json<{ error: { code: string; details: Record<string, unknown> } }>();
  return { status: r.statusCode, code: body.error?.code, ...body.error?.details };
}

async function ok<T>(response: ReturnType<typeof call>, status = 200): Promise<T> {
  const r = await response;
  if (r.statusCode !== status) throw new Error(`${r.statusCode}: ${r.body}`);
  return r.json<T>();
}

async function customer(
  name: string,
  opts: { trn?: string; credit?: string } = {},
): Promise<string> {
  phone += 1;
  const c = await ok<CustomerDetail>(
    owner('POST', '/api/v1/customers', {
      customerType: 'company',
      name,
      phone: `050 ${phone}`,
      isVatRegistered: opts.trn !== undefined,
      // An A4 invoice is a full tax invoice and needs the address (0064, 0071).
      addressLine: 'Industrial Area 1',
      ...(opts.trn ? { trn: opts.trn } : {}),
    }),
    201,
  );
  if (opts.credit) {
    await ok(
      owner('POST', `/api/v1/customers/${c.id}/credit`, {
        credit: { mode: 'credit', creditLimitFils: opts.credit, paymentTermsDays: 30 },
        reason: 'Known contractor',
        rowVersion: c.rowVersion,
      }),
    );
  }
  return c.id;
}

async function item(
  code: string,
  type: 'stock' | 'service',
  price4dp: string,
  includesVat = false,
) {
  return ok<ItemDetail>(
    owner('POST', '/api/v1/items', {
      code,
      itemType: type,
      nameAr: `صنف ${code}`,
      nameEn: `Item ${code}`,
      categoryId: ids.category,
      unitId: type === 'stock' ? ids.pcs : ids.visit,
      vatCategoryId: ids.vat,
      price: { price4dp, includesVat },
    }),
    201,
  );
}

async function openingStock(itemId: string, qtyMilli: string, cost4dp: string) {
  await ok(
    owner('POST', '/api/v1/stock/adjustments', {
      kind: 'opening',
      reasonCodeId: ids.opening,
      lines: [{ itemId, quantityMilli: qtyMilli, unitCost4dp: cost4dp }],
    }),
    201,
  );
}

const draft = (who: Actor, body: Record<string, unknown>) =>
  ok<DocumentDetail>(who('POST', '/api/v1/sales/invoices', body), 201);
const issue = (who: Actor, doc: DocumentDetail, extra: Record<string, unknown> = {}) =>
  who('POST', `/api/v1/sales/documents/${doc.id}/issue`, { rowVersion: doc.rowVersion, ...extra });
const cash = (amountFils: string) => ({ paymentMethodId: ids.cash, amountFils });

async function entryOf(doc: { journalEntryId: string | null }) {
  const entry = await ok<JournalEntryDetail>(owner('GET', `/api/v1/journal/${doc.journalEntryId}`));
  const out: Record<string, bigint> = {};
  for (const l of entry.lines)
    out[l.accountCode] = (out[l.accountCode] ?? 0n) + BigInt(l.debitFils) - BigInt(l.creditFils);
  return out;
}

async function approval(permission: string, approver?: bigint) {
  return withBusinessTx(
    server.db,
    { userId: clerkId, deviceId: clerkPc.id, requestId: randomUUID() },
    async (trx) =>
      (
        await sql<{
          id: string;
        }>`INSERT INTO auth.approvals (permission_code, approved_by, reason_text)
                                  VALUES (${permission}, ${approver ?? accountantId}, 'Approved at the counter')
                                  RETURNING id::text`.execute(trx)
      ).rows[0]!.id,
  );
}

// The PDF renderer uses the pinned browser; locally the one the screen tests use.
// (Only when one is named: assigning undefined would store the text "undefined".)
if (process.env.ARTEPOOL_E2E_CHROMIUM)
  process.env.ARTEPOOL_CHROMIUM ??= process.env.ARTEPOOL_E2E_CHROMIUM;

beforeAll(async () => {
  server = await startTestServer();
  const office = await addDevice(server, { code: 'OFFICE-01' });
  ownerId = await addOwner(server);
  owner = actor(
    office,
    (await openSession(server, { userId: ownerId, deviceId: office.id, method: 'password_totp' }))
      .token,
  );
  const acc = await signedIn('acc.sales', ['accountant']);
  accountant = acc.act;
  accountantId = acc.id;
  const cash1 = await signedIn('cash.sales', ['cashier']);
  cashier = cash1.act;
  storekeeper = (await signedIn('store.sales', ['storekeeper'])).act;
  await server.admin.query('BEGIN');
  await server.admin.query(`SELECT sys.set_context($1, p_reason => 'test role')`, [
    ownerId.toString(),
  ]);
  await server.admin.query(
    `INSERT INTO auth.roles (code, name_ar, name_en, max_discount_bp, max_discount_fils)
     VALUES ('clerk', 'موظف مبيعات', 'Sales clerk', 1000, 50000)`,
  );
  await server.admin.query(
    `INSERT INTO auth.role_permissions (role_id, permission_code)
     SELECT r.id, p FROM auth.roles r,
            unnest(ARRAY['invoices.view', 'invoices.create', 'invoices.issue', 'payments.receive', 'customers.view',
                         'items.view']) p
      WHERE r.code = 'clerk'`,
  );
  await server.admin.query('COMMIT');
  const clerkUser = await signedIn('clerk.sales', ['clerk']);
  clerk = clerkUser.act;
  clerkId = clerkUser.id;
  clerkPc = clerkUser.pc;
  const { rows } = await sql<{ kind: string; id: string }>`
    SELECT 'category' AS kind, id::text FROM md.item_categories WHERE code = 'PARTS'
    UNION ALL SELECT 'pcs', id::text FROM md.units WHERE code = 'PCS'
    UNION ALL SELECT 'visit', id::text FROM md.units WHERE code = 'VISIT'
    UNION ALL SELECT 'vat', id::text FROM md.vat_categories WHERE code = 'SR'
    UNION ALL SELECT 'construction', id::text FROM md.business_lines WHERE code = 'construction'
    UNION ALL SELECT 'opening', id::text FROM sys.reason_codes WHERE category = 'other' AND code = 'OPENING'
    UNION ALL SELECT 'cnReturn', id::text FROM sys.reason_codes WHERE category = 'credit_note' AND code = 'RETURN'
    UNION ALL SELECT 'bounced', id::text FROM sys.reason_codes WHERE category = 'payment_reversal' AND code = 'BOUNCED'
    UNION ALL SELECT 'cash', id::text FROM md.payment_methods WHERE kind = 'cash' AND is_active ORDER BY 1 LIMIT 100
  `.execute(server.db);
  for (const r of rows) ids[r.kind] ??= r.id;
  await ok(
    owner('PUT', '/api/v1/company', {
      legalNameAr: 'آرتي بول لحمامات السباحة',
      legalNameEn: 'ARTEPOOL Swimming Pools',
      vatRegistered: true,
      trn: '100123456789012',
      addressAr: 'العين، أبوظبي',
      addressEn: 'Al Ain, Abu Dhabi',
    }),
  );
});
afterAll(() => server.close());

describe('line arithmetic (decisions 0009, 0012, 0014)', () => {
  it('the database works out every line exactly as the shared helper does', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 999_999n }),
        fc.bigInt({ min: 0n, max: 99_999_999n }),
        fc.boolean(),
        fc.constantFrom(0n, 500n),
        fc.integer({ min: 0, max: 100 }),
        async (quantity, unitPrice4dp, includesVat, rateBp, discountPct) => {
          const amount = (quantity * unitPrice4dp + 50_000n) / 100_000n;
          const lineDiscountFils = (amount * BigInt(discountPct)) / 100n;
          const expected = computeLine({
            quantity,
            unitPrice4dp,
            pricesIncludeVat: includesVat,
            vatRateBp: rateBp,
            lineDiscountFils,
          });
          const { rows } = await sql<{
            net_fils: string;
            vat_fils: string;
            gross_fils: string;
            discount_excl_vat_fils: string;
          }>`
            SELECT net_fils::text, vat_fils::text, gross_fils::text, discount_excl_vat_fils::text
              FROM sales.line_amounts(${quantity.toString()}::numeric / 1000, ${unitPrice4dp.toString()}::bigint,
                                      ${includesVat}, ${Number(rateBp)}, ${lineDiscountFils.toString()}::bigint, 0)`.execute(
            server.db,
          );
          expect(rows[0]).toEqual({
            net_fils: expected.netFils.toString(),
            vat_fils: expected.vatFils.toString(),
            gross_fils: expected.grossFils.toString(),
            discount_excl_vat_fils: expected.discountExclVatFils.toString(),
          });
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('invoices (decisions 0010, 0011, 0046)', () => {
  it('the walk-in cash customer on an A4 invoice: a simplified invoice, nothing to type (0071)', async () => {
    const { rows } = await sql<{ id: string }>`
      SELECT id::text FROM md.customers WHERE is_walk_in`.execute(server.db);
    const svc = await item('WALK-SVC', 'service', '1000000');
    const d = await draft(owner, {
      customerId: rows[0]!.id,
      lines: [{ itemId: svc.id, quantityMilli: '1000' }],
    });
    const issued = await ok<DocumentDetail>(issue(owner, d, { payments: [cash('10500')] }));
    expect(issued).toMatchObject({ invoiceFormat: 'simplified', billToTrn: null });
  });

  it('a sale paid at issue: number, stock out at cost, Receivable/Revenue/VAT and Cost of sales/Inventory', async () => {
    const cust = await customer('Walk-in shop');
    const pump = await item('PUMP-01', 'stock', '1000000'); // 100.00 + VAT
    await openingStock(pump.id, '5000', '600000'); // 5 × 60.00
    // The cashier only receives payments by default; preparing invoices is a permission of its own.
    expect(
      await refusal(
        cashier('POST', '/api/v1/sales/invoices', {
          customerId: cust,
          lines: [{ itemId: pump.id, quantityMilli: '1000' }],
        }),
      ),
    ).toMatchObject({ status: 403 });
    const d = await draft(clerk, {
      customerId: cust,
      lines: [{ itemId: pump.id, quantityMilli: '2000' }],
    });
    expect(d).toMatchObject({
      status: 'draft',
      docNumber: null,
      netFils: '20000',
      vatFils: '1000',
      totalFils: '21000',
    });
    expect(await refusal(issue(storekeeper, d))).toMatchObject({ status: 403 });
    const issued = await ok<DocumentDetail>(issue(accountant, d, { payments: [cash('21000')] }));
    expect(issued).toMatchObject({
      status: 'issued',
      // A4: a full tax invoice even for an unregistered customer, without a TRN (0071).
      invoiceFormat: 'full',
      billToTrn: null,
      settlementStatus: 'settled',
    });
    expect(issued.docNumber).toMatch(/^INV-/);
    const stock = await ok<ItemStockResponse>(owner('GET', `/api/v1/items/${pump.id}/stock`));
    expect(stock.balances[0]).toMatchObject({ quantityMilli: '3000' });
    expect(issued.settlements).toHaveLength(1);
    expect(issued.lines[0]).toMatchObject({
      netFils: '20000',
      vatFils: '1000',
      grossFils: '21000',
    });
  });

  it('the sale entry: 1210 +210.00, revenue −200.00, VAT −10.00, cost of sales +120.00, inventory −120.00', async () => {
    const cust = await customer('Hotel', { credit: '10000000' });
    const pump = await item('PUMP-02', 'stock', '1000000');
    await openingStock(pump.id, '5000', '600000');
    const d = await draft(accountant, {
      customerId: cust,
      lines: [{ itemId: pump.id, quantityMilli: '2000' }],
    });
    const issued = await ok<DocumentDetail>(issue(accountant, d));
    expect(await entryOf(issued)).toEqual({
      '1210': 21000n,
      '2130': -1000n,
      '4100': -20000n,
      '5100': 12000n,
      '1310': -12000n,
    });
    expect(issued.settlementStatus).toBe('open');
  });

  it('a VAT-registered customer gets a full tax invoice with the TRN; an unpaid cash sale needs approval', async () => {
    const registered = await customer('Registered LLC', { trn: '100987654321098' });
    const svc = await item('SVC-01', 'service', '500000'); // 50.00 + VAT
    const d = await draft(clerk, {
      customerId: registered,
      lines: [{ itemId: svc.id, quantityMilli: '1000' }],
    });
    expect(await refusal(issue(clerk, d))).toMatchObject({ status: 403, rule: 'CREDIT_LIMIT' });
    const approved = await ok<DocumentDetail>(
      issue(clerk, d, { creditApprovalId: await approval('sales.credit_over_limit') }),
    );
    expect(approved).toMatchObject({
      invoiceFormat: 'full',
      billToTrn: '100987654321098',
      settlementStatus: 'open',
    });
  });

  it('a discount above the clerk’s limit (10%) needs a supervisor; so does a changed price', async () => {
    const cust = await customer('Discount customer', { credit: '10000000' });
    const svc = await item('SVC-02', 'service', '1000000'); // 100.00 + VAT
    const big = await draft(clerk, {
      customerId: cust,
      lines: [{ itemId: svc.id, quantityMilli: '1000', lineDiscountBp: 2000 }],
    });
    expect(big.totalFils).toBe('8400'); // 80.00 + 4.00
    expect(await refusal(issue(clerk, big))).toMatchObject({
      status: 403,
      rule: 'DISCOUNT_OVER_LIMIT',
    });
    const issued = await ok<DocumentDetail>(
      issue(clerk, big, { approvalId: await approval('sales.discount_over_limit') }),
    );
    expect(issued.discountTotalFils).toBe('2000');
    const small = await draft(clerk, {
      customerId: cust,
      lines: [{ itemId: svc.id, quantityMilli: '1000', lineDiscountBp: 1000 }],
    });
    await ok(issue(clerk, small)); // 10% is within the limit
    const priced = await draft(clerk, {
      customerId: cust,
      lines: [{ itemId: svc.id, quantityMilli: '1000', unitPrice4dp: '900000' }],
    });
    expect(await refusal(issue(clerk, priced))).toMatchObject({ rule: 'PRICE_OVERRIDE' });
    await ok(issue(clerk, priced, { approvalId: await approval('sales.price_override') }));
  });
});

describe('the advance and progress payments example (decision 0013)', () => {
  it('quotation 100,000 + VAT → receive 31,500 → 42,000 → final invoice: 31,500 due, VAT 1,500', async () => {
    const dash = () =>
      ok<DashboardResponse>(owner('GET', '/api/v1/reports/owner-dashboard?period=today'));
    const before = await dash();
    const cust = await customer('Villa owner', { credit: '100000000' });
    const pool = await item('POOL-01', 'service', '1000000000'); // 100,000.00 + VAT
    const q = await ok<QuotationDetail>(
      accountant('POST', '/api/v1/sales/quotations', {
        customerId: cust,
        businessLineId: ids.construction,
        subject: 'Swimming pool 10 × 5 m',
        lines: [{ itemId: pool.id, quantityMilli: '1000' }],
      }),
      201,
    );
    expect(q).toMatchObject({ status: 'draft', totalFils: '10500000' });
    expect(q.docNumber).toMatch(/^Q-/);
    const sent = await ok<QuotationDetail>(
      accountant('POST', `/api/v1/sales/quotations/${q.id}/action`, {
        action: 'send',
        rowVersion: q.rowVersion,
      }),
    );
    const pay = async (amount: string) =>
      ok<ReceivePaymentResponse>(
        accountant('POST', '/api/v1/sales/payments', {
          customerId: cust,
          part: cash(amount),
          asAdvance: true,
          quotationId: q.id,
        }),
        201,
      );
    const p1 = await pay('3150000');
    expect(p1.payment.docNumber).toMatch(/^RCT-/);
    expect(p1.advanceInvoice).toMatchObject({
      docType: 'advance_invoice',
      netFils: '3000000',
      vatFils: '150000',
    });
    expect(p1.advanceInvoice!.docNumber).toMatch(/^INV-/);
    expect(await entryOf(p1.advanceInvoice!)).toEqual({
      '1210': 3150000n,
      '2120': -3000000n,
      '2130': -150000n,
    });
    const p2 = await pay('4200000');
    expect(p2.advanceInvoice).toMatchObject({ vatFils: '200000' });

    const draftInvoice = await ok<DocumentDetail>(
      accountant('POST', `/api/v1/sales/quotations/${q.id}/convert`, {
        rowVersion: sent.rowVersion,
      }),
      201,
    );
    expect(draftInvoice.deductible!.map((a) => a.id).sort()).toEqual(
      [p1.advanceInvoice!.id, p2.advanceInvoice!.id].sort(),
    );
    const withDeductions = await ok<DocumentDetail>(
      accountant('PUT', `/api/v1/sales/invoices/${draftInvoice.id}`, {
        customerId: cust,
        quotationId: q.id,
        businessLineId: ids.construction,
        lines: [{ itemId: pool.id, quantityMilli: '1000' }],
        deductions: [
          { advanceDocumentId: p1.advanceInvoice!.id },
          { advanceDocumentId: p2.advanceInvoice!.id },
        ],
        rowVersion: draftInvoice.rowVersion,
      }),
    );
    const final = await ok<DocumentDetail>(issue(accountant, withDeductions));
    expect(final).toMatchObject({ netFils: '3000000', vatFils: '150000', totalFils: '3150000' });
    expect(final.lines.filter((l) => l.lineKind === 'advance_deduction')).toHaveLength(2);
    expect(await entryOf(final)).toEqual({
      '1210': 3150000n,
      '2120': 7000000n,
      '4200': -10000000n,
      '2130': -150000n,
    });
    // VAT over the three documents: 1,500 + 2,000 + 1,500 = 5,000.00, charged once.
    const { rows } = await sql<{ v: string }>`
      SELECT sum(vat_fils)::text AS v FROM sales.documents WHERE customer_id = ${BigInt(cust)} AND status = 'issued'`.execute(
      server.db,
    );
    expect(rows[0]!.v).toBe('500000');
    // The printed final invoice: both languages, the seller's TRN, the deductions; a PDF that opens.
    const printed = await documentHtml(server.db, BigInt(final.id));
    expect(printed.html).toContain('Tax Invoice');
    expect(printed.html).toContain('فاتورة ضريبية');
    expect(printed.html).toContain('100123456789012');
    expect(printed.html).toContain('Less: earlier payments');
    expect(printed.html).toContain('31,500.00');
    expect(printed.html).not.toContain('COPY');
    if (process.env.ARTEPOOL_PRINT_PREVIEW)
      writeFileSync(process.env.ARTEPOOL_PRINT_PREVIEW, printed.html);
    const file = await ok<{ fileName: string; mime: string; dataBase64: string }>(
      accountant('GET', `/api/v1/sales/documents/${final.id}/pdf`),
    );
    expect(file).toMatchObject({ fileName: `${final.docNumber}.pdf`, mime: 'application/pdf' });
    expect(Buffer.from(file.dataBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    // Printed once, then again: the second is a copy (decision 0008).
    await ok(accountant('POST', `/api/v1/sales/documents/${final.id}/printed`, {}));
    await ok(accountant('POST', `/api/v1/sales/documents/${final.id}/printed`, {}));
    expect((await documentHtml(server.db, BigInt(final.id))).html).toContain('COPY');
    const balance = await ok<CustomerBalance>(owner('GET', `/api/v1/customers/${cust}/balance`));
    expect(balance.amounts).toMatchObject({ outstandingFils: '3150000', advancesFils: '0' });
    // The owner dashboard counts the project once: two advances + the final invoice = 100,000 + VAT.
    const after = await dash();
    expect(BigInt(after.current.netFils) - BigInt(before.current.netFils)).toBe(10000000n);
    expect(BigInt(after.current.vatFils) - BigInt(before.current.vatFils)).toBe(500000n);
    expect(BigInt(after.current.totalFils) - BigInt(before.current.totalFils)).toBe(10500000n);
  });
});

describe('payments (decisions 0048, 0052)', () => {
  it('settle the oldest first; the rest becomes a payment invoice; a bounced cheque reopens and reverses', async () => {
    const cust = await customer('Contractor', { credit: '100000000' });
    const svc = await item('SVC-03', 'service', '1000000'); // 105.00 each
    const one = async () =>
      ok<DocumentDetail>(
        issue(
          accountant,
          await draft(accountant, {
            customerId: cust,
            lines: [{ itemId: svc.id, quantityMilli: '1000' }],
          }),
        ),
      );
    const first = await one();
    const second = await one();
    const r = await ok<ReceivePaymentResponse>(
      accountant('POST', '/api/v1/sales/payments', { customerId: cust, part: cash('25000') }),
      201,
    );
    expect(r.payment.allocations.map((a) => [a.documentId, a.amountFils])).toEqual([
      [first.id, '10500'],
      [second.id, '10500'],
      [r.advanceInvoice!.id, '4000'],
    ]);
    expect(r.advanceInvoice).toMatchObject({ totalFils: '4000', vatFils: '190' });

    const reversed = await ok<PaymentDetail>(
      accountant('POST', `/api/v1/sales/payments/${r.payment.id}/reverse`, {
        reasonCodeId: ids.bounced,
      }),
      201,
    );
    expect(reversed.docNumber).toMatch(/^RVS-/);
    const reopened = await ok<DocumentDetail>(owner('GET', `/api/v1/sales/documents/${first.id}`));
    expect(reopened.settlementStatus).toBe('open');
    // The payment invoice is reversed by a credit note: its advance is used up.
    const adv = await ok<DocumentDetail>(
      owner('GET', `/api/v1/sales/documents/${r.advanceInvoice!.id}`),
    );
    expect(adv).toMatchObject({
      advanceLeftNetFils: '0',
      advanceLeftVatFils: '0',
      settlementStatus: 'settled',
    });
    expect(
      await refusal(
        accountant('POST', `/api/v1/sales/payments/${r.payment.id}/reverse`, {
          reasonCodeId: ids.bounced,
        }),
      ),
    ).toMatchObject({
      status: 422,
    });
    expect(
      await refusal(
        cashier('POST', `/api/v1/sales/payments/${r.payment.id}/reverse`, {
          reasonCodeId: ids.bounced,
        }),
      ),
    ).toMatchObject({
      status: 403,
    });
  });
});

describe('credit notes (decision 0015)', () => {
  it('goods back to defective stock at their old cost; applied to the unpaid invoice; never more than sold', async () => {
    const cust = await customer('Returns', { credit: '10000000' });
    const heater = await item('HEAT-01', 'stock', '2000000'); // 200.00 + VAT
    await openingStock(heater.id, '3000', '1500000'); // 150.00 each
    const inv = await ok<DocumentDetail>(
      issue(
        accountant,
        await draft(accountant, {
          customerId: cust,
          lines: [{ itemId: heater.id, quantityMilli: '2000' }],
        }),
      ),
    );
    const line = inv.lines[0]!;
    const note = await ok<DocumentDetail>(
      accountant('POST', '/api/v1/sales/notes', {
        kind: 'credit_note',
        originalDocumentId: inv.id,
        reasonCodeId: ids.cnReturn,
        reasonText: 'Broken on delivery',
        lines: [{ originalLineId: line.id, quantityMilli: '1000', returnStockStatus: 'defective' }],
      }),
      201,
    );
    expect(note.docNumber).toMatch(/^CN-/);
    expect(note).toMatchObject({ totalFils: '21000', settlementStatus: 'settled' });
    expect(await entryOf(note)).toEqual({
      '1210': -21000n,
      '2130': 1000n,
      '4100': 20000n,
      '5100': -15000n,
      '1320': 15000n,
    });
    const stock = await ok<ItemStockResponse>(owner('GET', `/api/v1/items/${heater.id}/stock`));
    expect(stock.balances.find((b) => b.stockStatus === 'defective')).toMatchObject({
      quantityMilli: '1000',
    });
    const after = await ok<DocumentDetail>(owner('GET', `/api/v1/sales/documents/${inv.id}`));
    expect(after).toMatchObject({ settledFils: '21000', settlementStatus: 'partial' });
    expect(
      await refusal(
        accountant('POST', '/api/v1/sales/notes', {
          kind: 'credit_note',
          originalDocumentId: inv.id,
          reasonCodeId: ids.cnReturn,
          reasonText: 'Again',
          lines: [{ originalLineId: line.id, quantityMilli: '2000' }],
        }),
      ),
    ).toMatchObject({ rule: 'NOTE_EXCEEDS' });
    // A cashier needs a supervisor's approval to issue a credit note.
    expect(
      await refusal(
        clerk('POST', '/api/v1/sales/notes', {
          kind: 'credit_note',
          originalDocumentId: inv.id,
          reasonCodeId: ids.cnReturn,
          reasonText: 'Return',
          lines: [{ originalLineId: line.id, quantityMilli: '1000' }],
        }),
      ),
    ).toMatchObject({ status: 403 });
  });
});

describe('opening balances and the statement (decision 0051)', () => {
  it('the owner enters it once; the statement runs from it; the receivable account equals the customers', async () => {
    const cust = await customer('Old friend', { credit: '10000000' });
    expect(
      await refusal(
        accountant('POST', '/api/v1/customers/opening-balances', {
          customerId: cust,
          direction: 'receivable',
          amountFils: '50000',
        }),
      ),
    ).toMatchObject({ status: 403 });
    await ok(
      owner('POST', '/api/v1/customers/opening-balances', {
        customerId: cust,
        direction: 'receivable',
        amountFils: '50000',
      }),
      201,
    );
    const svc = await item('SVC-04', 'service', '1000000');
    await ok(
      issue(
        accountant,
        await draft(accountant, {
          customerId: cust,
          lines: [{ itemId: svc.id, quantityMilli: '1000' }],
        }),
      ),
    );
    await ok(
      accountant('POST', '/api/v1/sales/payments', { customerId: cust, part: cash('50000') }),
      201,
    );
    const { rows } = await sql<{ d: string }>`SELECT sys.business_date()::text AS d`.execute(
      server.db,
    );
    const st = await ok<StatementResponse>(
      owner(
        'GET',
        `/api/v1/customers/${cust}/statement?from=${rows[0]!.d.slice(0, 8)}01&to=${rows[0]!.d}`,
      ),
    );
    expect(st.lines.map((l) => l.kind)).toEqual(['opening_balance', 'invoice', 'receipt']);
    expect(st.closingFils).toBe('10500');

    // The receivable control account equals the sum of every customer's balance.
    const tb = await ok<TrialBalanceResponse>(
      owner('GET', `/api/v1/trial-balance?from=${rows[0]!.d.slice(0, 8)}01&to=${rows[0]!.d}`),
    );
    const ar = tb.rows.find((r) => r.code === '1210')?.balanceFils ?? '0';
    const { rows: sum } = await sql<{ s: string }>`
      SELECT coalesce(sum(sales.customer_balance(id)), 0)::text AS s FROM md.customers`.execute(
      server.db,
    );
    expect(ar).toBe(sum[0]!.s);
  });

  it('only people with the permissions reach sales', async () => {
    expect((await storekeeper('GET', '/api/v1/sales/documents')).statusCode).toBe(403);
    expect((await storekeeper('GET', '/api/v1/sales/quotations')).statusCode).toBe(403);
    expect((await cashier('POST', '/api/v1/customers/opening-balances', {})).statusCode).toBe(403);
    // The cashier sees customers but not their statement of account (statements.view).
    expect(
      (await cashier('GET', '/api/v1/customers/1/statement?from=2026-01-01&to=2026-01-31'))
        .statusCode,
    ).toBe(403);
    expect(
      (await cashier('GET', '/api/v1/customers/1/statement/pdf?from=2026-01-01&to=2026-01-31'))
        .statusCode,
    ).toBe(403);
  });

  it('receipts can be listed by payment method', async () => {
    const all = await ok<PaymentsResponse>(
      accountant('GET', '/api/v1/sales/payments?pageSize=200'),
    );
    const cashOnly = await ok<PaymentsResponse>(
      accountant('GET', '/api/v1/sales/payments?methodKind=cash&pageSize=200'),
    );
    expect(cashOnly.payments.every((p) => p.methodKind === 'cash')).toBe(true);
    expect(cashOnly.payments.length).toBe(
      all.payments.filter((p) => p.methodKind === 'cash').length,
    );
    const cheques = await ok<PaymentsResponse>(
      accountant('GET', '/api/v1/sales/payments?methodKind=cheque&pageSize=200'),
    );
    expect(cheques.payments.every((p) => p.methodKind === 'cheque')).toBe(true);
  });
});

describe('fixes from the M4 screens review', () => {
  it('a draft converted from a quotation keeps its agreed prices and discount when saved again', async () => {
    const cust = await customer('Quoted villa', { credit: '100000000' });
    const svc = await item('SVC-Q1', 'service', '10000000'); // 1,000.00 + VAT
    const q = await ok<QuotationDetail>(
      accountant('POST', '/api/v1/sales/quotations', {
        customerId: cust,
        docDiscountFils: '5000',
        lines: [{ itemId: svc.id, quantityMilli: '1000', unitPrice4dp: '9000000' }], // 900.00
      }),
      201,
    );
    const sent = await ok<QuotationDetail>(
      accountant('POST', `/api/v1/sales/quotations/${q.id}/action`, {
        action: 'send',
        rowVersion: q.rowVersion,
      }),
    );
    const converted = await ok<DocumentDetail>(
      accountant('POST', `/api/v1/sales/quotations/${q.id}/convert`, {
        rowVersion: sent.rowVersion,
      }),
      201,
    );
    expect(converted).toMatchObject({ docDiscountFils: '5000', totalFils: sent.totalFils });
    const line = converted.lines[0]!;
    expect(line.quotationLineId).toBe(q.lines[0]!.id);
    // Saved again as the screen sends it: the line names its quotation line, no price typed.
    const saved = await ok<DocumentDetail>(
      accountant('PUT', `/api/v1/sales/invoices/${converted.id}`, {
        customerId: cust,
        docDiscountFils: '5000',
        dueDate: '2026-12-31',
        lines: [{ itemId: svc.id, quantityMilli: '1000', quotationLineId: line.quotationLineId }],
        rowVersion: converted.rowVersion,
      }),
    );
    expect(saved.lines[0]).toMatchObject({ unitPrice4dp: '9000000', listPrice4dp: '9000000' });
    expect(saved.totalFils).toBe(sent.totalFils); // (900.00 − 50.00) + 5% = 892.50
    expect(saved.totalFils).toBe('89250');
    // A line of another quotation is refused.
    const other = await ok<QuotationDetail>(
      accountant('POST', '/api/v1/sales/quotations', {
        customerId: cust,
        lines: [{ itemId: svc.id, quantityMilli: '1000' }],
      }),
      201,
    );
    expect(
      await refusal(
        accountant('PUT', `/api/v1/sales/invoices/${converted.id}`, {
          customerId: cust,
          lines: [{ itemId: svc.id, quantityMilli: '1000', quotationLineId: other.lines[0]!.id }],
          rowVersion: saved.rowVersion,
        }),
      ),
    ).toMatchObject({ status: 422 });
  });

  it('a price approval does not waive the discount limit: each needs its own approval', async () => {
    const cust = await customer('Two approvals', { credit: '10000000' });
    const svc = await item('SVC-A2', 'service', '1000000'); // 100.00 + VAT
    const doc = await draft(clerk, {
      customerId: cust,
      lines: [
        { itemId: svc.id, quantityMilli: '1000', unitPrice4dp: '900000', lineDiscountBp: 2000 },
      ],
    });
    expect(
      await refusal(issue(clerk, doc, { approvalId: await approval('sales.price_override') })),
    ).toMatchObject({ rule: 'DISCOUNT_OVER_LIMIT' });
    expect(
      await refusal(
        issue(clerk, doc, { priceApprovalId: await approval('sales.discount_over_limit') }),
      ),
    ).toMatchObject({ code: 'APPROVAL_INVALID' });
    const issued = await ok<DocumentDetail>(
      issue(clerk, doc, {
        priceApprovalId: await approval('sales.price_override'),
        approvalId: await approval('sales.discount_over_limit'),
      }),
    );
    expect(issued.status).toBe('issued');
    // The same on a quotation when it is sent.
    const q = await ok<QuotationDetail>(
      accountant('POST', '/api/v1/sales/quotations', {
        customerId: cust,
        lines: [
          { itemId: svc.id, quantityMilli: '1000', unitPrice4dp: '900000', lineDiscountBp: 2000 },
        ],
      }),
      201,
    );
    // (The clerk role has no quotations.manage: check the database rule directly as the clerk.)
    const sendAsClerk = (approvalId: string | null, priceApprovalId: string | null) =>
      withBusinessTx(
        server.db,
        { userId: clerkId, deviceId: clerkPc.id, requestId: randomUUID() },
        async (trx) =>
          sql`UPDATE sales.quotations SET status = 'sent', approval_id = ${approvalId}::bigint,
                     price_approval_id = ${priceApprovalId}::bigint WHERE id = ${BigInt(q.id)}`.execute(
            trx,
          ),
      );
    await expect(sendAsClerk(null, await approval('sales.price_override'))).rejects.toMatchObject({
      details: { rule: 'DISCOUNT_OVER_LIMIT' },
    });
    await expect(sendAsClerk(await approval('sales.price_override'), null)).rejects.toMatchObject({
      message: 'This approval is for something else',
    });
  });

  it('a final invoice fully covered by an advance is settled and never blocks a later receipt', async () => {
    const cust = await customer('Prepaid');
    const svc = await item('SVC-P1', 'service', '1000000'); // 100.00 + VAT
    const paid = await ok<ReceivePaymentResponse>(
      accountant('POST', '/api/v1/sales/payments', {
        customerId: cust,
        part: cash('10500'),
        asAdvance: true,
      }),
      201,
    );
    const final = await ok<DocumentDetail>(
      issue(
        accountant,
        await draft(accountant, {
          customerId: cust,
          lines: [{ itemId: svc.id, quantityMilli: '1000' }],
          deductions: [{ advanceDocumentId: paid.advanceInvoice!.id }],
        }),
      ),
    );
    expect(final).toMatchObject({ totalFils: '0', settlementStatus: 'settled' });
    // An automatic receipt afterwards: nothing to settle, so all of it is an advance.
    const later = await ok<ReceivePaymentResponse>(
      accountant('POST', '/api/v1/sales/payments', { customerId: cust, part: cash('2100') }),
      201,
    );
    expect(later.advanceInvoice).toMatchObject({ totalFils: '2100' });
  });

  it('a reprint needs documents.reprint on the server too', async () => {
    const cust = await customer('Reprints', { credit: '10000000' });
    const svc = await item('SVC-R1', 'service', '1000000');
    const doc = await ok<DocumentDetail>(
      issue(
        clerk,
        await draft(clerk, {
          customerId: cust,
          lines: [{ itemId: svc.id, quantityMilli: '1000' }],
        }),
      ),
    );
    await ok(clerk('GET', `/api/v1/sales/documents/${doc.id}/pdf`));
    await ok(clerk('POST', `/api/v1/sales/documents/${doc.id}/printed`, {}));
    expect(await refusal(clerk('GET', `/api/v1/sales/documents/${doc.id}/pdf`))).toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(
      await refusal(clerk('POST', `/api/v1/sales/documents/${doc.id}/printed`, {})),
    ).toMatchObject({ status: 403 });
    await ok(accountant('POST', `/api/v1/sales/documents/${doc.id}/printed`, {}));
  });

  it('a credit note follows the original line even after the item price changes', async () => {
    const cust = await customer('Price moved', { credit: '10000000' });
    const svc = await item('SVC-N1', 'service', '1000000'); // 100.00 + VAT
    const inv = await ok<DocumentDetail>(
      issue(
        accountant,
        await draft(accountant, {
          customerId: cust,
          lines: [{ itemId: svc.id, quantityMilli: '1000' }],
        }),
      ),
    );
    // The price changes to 126.00 including VAT.
    await withBusinessTx(
      server.db,
      { userId: accountantId, deviceId: clerkPc.id, requestId: randomUUID() },
      async (trx) =>
        sql`UPDATE md.item_prices SET price_4dp = 1260000, includes_vat = true
             WHERE item_id = ${BigInt(svc.id)}`.execute(trx),
    );
    const note = await ok<DocumentDetail>(
      accountant('POST', '/api/v1/sales/notes', {
        kind: 'credit_note',
        originalDocumentId: inv.id,
        reasonCodeId: ids.cnReturn,
        reasonText: 'Service not done',
        lines: [{ originalLineId: inv.lines[0]!.id, quantityMilli: '1000' }],
      }),
      201,
    );
    expect(note).toMatchObject({ netFils: '10000', vatFils: '500', totalFils: '10500' });
    expect(note.lines[0]).toMatchObject({ listPrice4dp: '1000000', priceIncludesVat: false });
  });
});

describe('cancelling or editing an issued A4 invoice (decision 0072)', () => {
  it('the owner cancels a paid invoice: a credit note for all of it, stock back, cash refunded', async () => {
    const cust = await customer('Cancel me');
    const pump = await item('CANCEL-PUMP', 'stock', '1000000');
    await openingStock(pump.id, '5000', '600000');
    const d = await draft(owner, {
      customerId: cust,
      lines: [{ itemId: pump.id, quantityMilli: '2000' }],
    });
    const issued = await ok<DocumentDetail>(issue(owner, d, { payments: [cash('21000')] }));
    // The whole paid amount goes back, no more and no less.
    expect(
      await refusal(
        owner('POST', `/api/v1/sales/documents/${issued.id}/cancel`, {
          mode: 'cancel',
          reason: 'Customer changed their mind',
          refund: [cash('10000')],
          rowVersion: issued.rowVersion,
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    const result = await ok<CancelInvoiceResponse>(
      owner('POST', `/api/v1/sales/documents/${issued.id}/cancel`, {
        mode: 'cancel',
        reason: 'Customer changed their mind',
        refund: [cash('21000')],
        rowVersion: issued.rowVersion,
      }),
    );
    expect(result.draftId).toBeNull();
    expect(result.creditNote).toMatchObject({ docType: 'credit_note', totalFils: '21000' });
    expect(result.creditNote.docNumber).toMatch(/^CN-/);
    const after = await ok<DocumentDetail>(owner('GET', `/api/v1/sales/documents/${issued.id}`));
    expect(after.status).toBe('issued'); // never changed, never deleted
    expect(after.cancelledBy).toMatchObject({
      docNumber: result.creditNote.docNumber,
      edited: false,
    });
    // The list says so too, and its status filter finds it under "cancelled", not "active".
    const listed = async (status: string) =>
      (
        await ok<DocumentsResponse>(
          owner('GET', `/api/v1/sales/documents?customerId=${cust}&status=${status}`),
        )
      ).documents.map((x) => x.docNumber);
    const all = await ok<DocumentsResponse>(
      owner('GET', `/api/v1/sales/documents?customerId=${cust}`),
    );
    expect(all.documents.find((x) => x.id === issued.id)?.cancelledBy).toMatchObject({
      docNumber: result.creditNote.docNumber,
      edited: false,
    });
    expect(all.documents.find((x) => x.id === result.creditNote.id)).toMatchObject({
      cancelledBy: null,
      originalDocumentNumber: issued.docNumber,
    });
    expect(await listed('cancelled')).toEqual([issued.docNumber]);
    expect(await listed('active')).toEqual([result.creditNote.docNumber]);
    expect(await listed('issued')).toEqual(
      expect.arrayContaining([issued.docNumber, result.creditNote.docNumber]),
    );
    const stock = await ok<ItemStockResponse>(owner('GET', `/api/v1/items/${pump.id}/stock`));
    expect(stock.balances[0]).toMatchObject({ quantityMilli: '5000' });
    const balance = await ok<CustomerBalance>(owner('GET', `/api/v1/customers/${cust}/balance`));
    expect(balance.amounts?.outstandingFils).toBe('0');
    // Only once.
    expect(
      await refusal(
        owner('POST', `/api/v1/sales/documents/${issued.id}/cancel`, {
          mode: 'cancel',
          reason: 'Again',
          rowVersion: after.rowVersion,
        }),
      ),
    ).toMatchObject({ rule: 'INVOICE_HAS_NOTES' });
  });

  it('someone else needs the owner’s approval; editing opens a new draft copied from it', async () => {
    const cust = await customer('Edit me', { credit: '10000000' });
    const svc = await item('EDIT-SVC', 'service', '1000000');
    const d = await draft(clerk, {
      customerId: cust,
      customerPo: 'PO-9',
      lines: [{ itemId: svc.id, quantityMilli: '3000' }],
    });
    const issued = await ok<DocumentDetail>(issue(accountant, d));
    const body = { mode: 'edit', reason: 'Wrong quantity', rowVersion: issued.rowVersion };
    expect(
      await refusal(clerk('POST', `/api/v1/sales/documents/${issued.id}/cancel`, body)),
    ).toMatchObject({ code: 'PERMISSION_DENIED' });
    // The accountant cannot approve it: the permission is the owner's.
    await expect(approval('invoices.cancel')).rejects.toBeTruthy();
    const approved = await approval('invoices.cancel', ownerId);
    const result = await ok<CancelInvoiceResponse>(
      clerk('POST', `/api/v1/sales/documents/${issued.id}/cancel`, {
        ...body,
        approvalId: approved,
      }),
    );
    expect(result.creditNote.totalFils).toBe(issued.totalFils);
    const copy = await ok<DocumentDetail>(
      owner('GET', `/api/v1/sales/documents/${result.draftId}`),
    );
    expect(copy).toMatchObject({
      status: 'draft',
      docNumber: null,
      customerId: cust,
      customerPo: 'PO-9',
    });
    expect(copy.lines.map((l) => l.quantityMilli)).toEqual(['3000']);
    const original = await ok<DocumentDetail>(owner('GET', `/api/v1/sales/documents/${issued.id}`));
    expect(original.cancelledBy).toMatchObject({ edited: true });
    // The unpaid invoice was settled by the credit note: nothing is owed.
    const balance = await ok<CustomerBalance>(owner('GET', `/api/v1/customers/${cust}/balance`));
    expect(balance.amounts?.outstandingFils).toBe('0');
  });
});

describe('receipts settle open invoices first; one worked-out status (decision 0113)', () => {
  const walkIn = async () =>
    (
      await sql<{ id: string }>`SELECT id::text FROM md.customers WHERE is_walk_in`.execute(
        server.db,
      )
    ).rows[0]!.id;
  /** An unpaid invoice (the clerk, with a supervisor's credit approval, 0046). */
  async function unpaid(customerId: string, price4dp: string, extra: Record<string, unknown> = {}) {
    phone += 1;
    const svc = await item(`R113-${phone}`, 'service', price4dp);
    const d = await draft(clerk, {
      customerId,
      lines: [{ itemId: svc.id, quantityMilli: '1000' }],
      ...extra,
    });
    return ok<DocumentDetail>(
      issue(clerk, d, { creditApprovalId: await approval('sales.credit_over_limit') }),
    );
  }
  const receive = (who: Actor, body: Record<string, unknown>) =>
    who('POST', '/api/v1/sales/payments', body);
  const doc = (id: string) => ok<DocumentDetail>(owner('GET', `/api/v1/sales/documents/${id}`));

  it("the owner's test: paying an invoice from its page settles it; no extra invoice row", async () => {
    const cust = await walkIn();
    const inv = await unpaid(cust, '571429'); // 57.1429 + 5% = 60.00
    expect(inv).toMatchObject({ totalFils: '6000', settlementStatus: 'open', overdue: false });
    const r = await ok<ReceivePaymentResponse>(
      receive(accountant, {
        customerId: cust,
        part: cash('6000'),
        allocations: [{ documentId: inv.id, amountFils: '6000' }],
      }),
      201,
    );
    expect(r.advanceInvoice).toBeNull();
    expect(r.payment.allocations.map((a) => [a.docNumber, a.amountFils])).toEqual([
      [inv.docNumber, '6000'],
    ]);
    expect(await doc(inv.id)).toMatchObject({ settlementStatus: 'settled', settledFils: '6000' });
    const list = await ok<DocumentsResponse>(
      owner('GET', `/api/v1/sales/documents?customerId=${cust}&group=invoices&pageSize=200`),
    );
    expect(list.documents.filter((d) => d.docType === 'advance_invoice')).toEqual([]);
  });

  it('partial payments: partially paid, then paid', async () => {
    const cust = await customer('Partial payer', { credit: '10000000' });
    const inv = await unpaid(cust, '1000000'); // 105.00
    await ok(receive(accountant, { customerId: cust, part: cash('4000') }), 201);
    expect(await doc(inv.id)).toMatchObject({ settlementStatus: 'partial', settledFils: '4000' });
    const r = await ok<ReceivePaymentResponse>(
      receive(accountant, { customerId: cust, part: cash('6500') }),
      201,
    );
    expect(r.advanceInvoice).toBeNull();
    expect(await doc(inv.id)).toMatchObject({ settlementStatus: 'settled', settledFils: '10500' });
  });

  it('an overpayment: the invoice is paid and only the excess becomes an advance', async () => {
    const cust = await customer('Overpayer', { credit: '10000000' });
    const inv = await unpaid(cust, '1000000'); // 105.00
    const r = await ok<ReceivePaymentResponse>(
      receive(accountant, { customerId: cust, part: cash('50000') }),
      201,
    );
    expect(r.payment.allocations.map((a) => [a.documentId, a.amountFils])).toEqual([
      [inv.id, '10500'],
      [r.advanceInvoice!.id, '39500'],
    ]);
    expect(r.payment.advanceReason).toBeNull();
  });

  it('amounts chosen per invoice first; what is left still pays the other open invoices', async () => {
    const cust = await customer('Chooser', { credit: '10000000' });
    const older = await unpaid(cust, '1000000'); // 105.00
    const newer = await unpaid(cust, '1000000'); // 105.00
    const r = await ok<ReceivePaymentResponse>(
      receive(accountant, {
        customerId: cust,
        part: cash('25000'),
        allocations: [{ documentId: newer.id, amountFils: '3000' }],
      }),
      201,
    );
    expect(r.payment.allocations.map((a) => [a.documentId, a.amountFils])).toEqual([
      [newer.id, '3000'],
      [older.id, '10500'],
      [newer.id, '7500'],
      [r.advanceInvoice!.id, '4000'],
    ]);
  });

  it('an advance while invoices are open: the permission, a reason, kept and audited', async () => {
    const cust = await customer('Disputed contractor', { credit: '10000000' });
    const old = await unpaid(cust, '1000000');
    const deposit = { customerId: cust, part: cash('50000'), asAdvance: true };
    // The cashier receives payments but may not keep one as an advance while invoices are open.
    expect(await refusal(receive(cashier, deposit))).toMatchObject({ status: 403 });
    expect(await refusal(receive(accountant, deposit))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const r = await ok<ReceivePaymentResponse>(
      receive(accountant, { ...deposit, advanceReason: 'Deposit for the new pool; INV disputed' }),
      201,
    );
    expect(r.payment.allocations.map((a) => [a.documentId, a.amountFils])).toEqual([
      [r.advanceInvoice!.id, '50000'],
    ]);
    expect(r.payment.advanceReason).toBe('Deposit for the new pool; INV disputed');
    expect(await doc(old.id)).toMatchObject({ settlementStatus: 'open' });
    const { rows } = await sql<{ reason: string | null }>`
      SELECT reason FROM audit.log
       WHERE entity_type = 'sales.payments' AND entity_id = ${r.payment.id}
         AND action = 'insert'`.execute(server.db);
    expect(rows[0]?.reason).toBe('Deposit for the new pool; INV disputed');
    // With nothing open, an advance needs neither (decision 0013 as before).
    const clean = await customer('Clean deposit', { credit: '10000000' });
    const plain = await ok<ReceivePaymentResponse>(
      receive(cashier, { customerId: clean, part: cash('20000'), asAdvance: true }),
      201,
    );
    expect(plain.advanceInvoice).not.toBeNull();
    expect(plain.payment.advanceReason).toBeNull();
  });

  it('overdue after the due date set from the payment terms; never when paid or cancelled', async () => {
    const cust = await walkIn(); // cash: due on receipt, so overdue from the next day
    const { rows } = await sql<{ d: string }>`
      SELECT (sys.business_date(now()) - 1)::text AS d`.execute(server.db);
    const yesterday = rows[0]!.d;
    const late = await unpaid(cust, '1000000', { issueDate: yesterday });
    expect(late).toMatchObject({ dueDate: yesterday, overdue: true });
    const credit = await customer('Thirty days', { credit: '10000000' });
    const fresh = await unpaid(credit, '1000000', { issueDate: yesterday });
    expect(fresh.overdue).toBe(false);
    expect(fresh.dueDate! > yesterday).toBe(true);
    const overdue = await ok<DocumentsResponse>(
      owner('GET', `/api/v1/sales/documents?settlement=overdue&pageSize=200`),
    );
    expect(overdue.documents.map((d) => d.id)).toContain(late.id);
    expect(overdue.documents.map((d) => d.id)).not.toContain(fresh.id);
    await ok(
      receive(accountant, {
        customerId: cust,
        part: cash('10500'),
        allocations: [{ documentId: late.id, amountFils: '10500' }],
      }),
      201,
    );
    expect((await doc(late.id)).overdue).toBe(false);
    // Cancelled (a credit note for all of it, 0072): cancelled with its number, never overdue.
    const dropped = await unpaid(cust, '1000000', { issueDate: yesterday });
    expect(dropped.overdue).toBe(true);
    const cancel = await ok<CancelInvoiceResponse>(
      owner('POST', `/api/v1/sales/documents/${dropped.id}/cancel`, {
        mode: 'cancel',
        reason: 'Not wanted',
        rowVersion: dropped.rowVersion,
      }),
    );
    expect(await doc(dropped.id)).toMatchObject({
      overdue: false,
      creditedFils: '10500',
      cancelledBy: { docNumber: cancel.creditNote.docNumber },
    });
  });

  it('a credit note made from the invoice: partially credited; Cancel is refused after it (0072)', async () => {
    const cust = await customer('Credited', { credit: '10000000' });
    phone += 1;
    const svc = await item(`R113-CN-${phone}`, 'service', '1000000');
    const d = await draft(clerk, {
      customerId: cust,
      lines: [{ itemId: svc.id, quantityMilli: '2000' }],
    });
    const inv = await ok<DocumentDetail>(
      issue(clerk, d, { creditApprovalId: await approval('sales.credit_over_limit') }),
    );
    const note = await ok<DocumentDetail>(
      accountant('POST', '/api/v1/sales/notes', {
        kind: 'credit_note',
        originalDocumentId: inv.id,
        reasonCodeId: ids.cnReturn,
        reasonText: 'One not needed',
        lines: [{ originalLineId: inv.lines[0]!.id, quantityMilli: '1000' }],
      }),
      201,
    );
    expect(note.originalDocumentId).toBe(inv.id);
    expect(await doc(inv.id)).toMatchObject({ creditedFils: '10500', cancelledBy: null });
    const again = await doc(inv.id);
    expect(
      await refusal(
        owner('POST', `/api/v1/sales/documents/${inv.id}/cancel`, {
          mode: 'cancel',
          reason: 'Customer cancelled',
          rowVersion: again.rowVersion,
        }),
      ),
    ).toMatchObject({ status: 422 }); // not when a note exists already (0072)
  });

  it('every settled amount matches its receipts and credit notes (integrity check)', async () => {
    const database = (await server.admin.query<{ db: string }>('SELECT current_database() AS db'))
      .rows[0]!.db;
    const { Client } = (await import('pg')).default;
    const { connectionFor } = await import('@artepool/node-kit');
    const { runChecks } = await import('@artepool/backup');
    const client = new Client({ ...connectionFor('superuser'), database });
    await client.connect();
    try {
      expect((await runChecks(client)).settlements).toEqual({
        ok: true,
        problems: 0,
        examples: [],
      });
    } finally {
      await client.end();
    }
  });
});

describe("the customer's balance (decision 0114)", () => {
  const balance = (who: Actor, id: string, detail = false) =>
    ok<CustomerBalance>(
      who('GET', `/api/v1/customers/${id}/balance${detail ? '?detail=yes' : ''}`),
    );
  const yesterday = async () =>
    (await sql<{ d: string }>`SELECT (sys.business_date(now()) - 1)::text AS d`.execute(server.db))
      .rows[0]!.d;
  /** An invoice for `quantity` services at 100.00 + VAT, issued unpaid (the clerk; approval if over). */
  async function invoiceOf(
    cust: string,
    quantityMilli: string,
    extra: Record<string, unknown> = {},
  ) {
    phone += 1;
    const svc = await item(`B114-${phone}`, 'service', '1000000');
    const d = await draft(clerk, {
      customerId: cust,
      lines: [{ itemId: svc.id, quantityMilli }],
    });
    return ok<DocumentDetail>(issue(clerk, d, extra));
  }

  it('from posted documents only: an invoice, a partial payment, a credit note, an opening balance', async () => {
    const cust = await customer('Balance contractor', { credit: '100000' }); // limit 1,000.00
    expect(await balance(accountant, cust)).toMatchObject({
      status: 'nothing_due',
      creditMode: 'credit',
      amounts: { outstandingFils: '0', overdueFils: '0', availableFils: '100000' },
    });
    const inv = await invoiceOf(cust, '2000'); // 210.00
    expect((await balance(accountant, cust)).amounts).toMatchObject({
      outstandingFils: '21000',
      availableFils: '79000',
    });
    await ok(
      accountant('POST', '/api/v1/sales/payments', { customerId: cust, part: cash('4000') }),
      201,
    );
    expect((await balance(accountant, cust)).amounts!.outstandingFils).toBe('17000');
    await ok(
      accountant('POST', '/api/v1/sales/notes', {
        kind: 'credit_note',
        originalDocumentId: inv.id,
        reasonCodeId: ids.cnReturn,
        reasonText: 'One not done',
        lines: [{ originalLineId: inv.lines[0]!.id, quantityMilli: '1000' }],
      }),
      201,
    );
    expect((await balance(accountant, cust)).amounts!.outstandingFils).toBe('6500');
    // An opening balance past its due date: outstanding and overdue (orange).
    const due = await yesterday();
    await ok(
      owner('POST', '/api/v1/customers/opening-balances', {
        customerId: cust,
        direction: 'receivable',
        amountFils: '30000',
        dueDate: due,
      }),
      201,
    );
    const after = await balance(accountant, cust, true);
    expect(after).toMatchObject({
      status: 'overdue',
      amounts: { outstandingFils: '36500', overdueFils: '30000', availableFils: '63500' },
    });
    // The customer page: oldest first, with ages and days overdue.
    expect(after.openDebts!.map((d) => [d.kind, d.dueFils, d.daysOverdue])).toEqual([
      ['opening_balance', '30000', 1],
      ['invoice', '6500', 0],
    ]);
    expect(after.oldestUnpaidDate).toBe(after.openDebts![0]!.date);
  });

  it('near the limit at 80%, over the limit above it; the same rule as the credit approval (0046)', async () => {
    const cust = await customer('Near the limit', { credit: '25000' }); // 250.00
    await invoiceOf(cust, '2000'); // 210.00 = 84%
    expect((await balance(accountant, cust)).status).toBe('near_limit');
    // Above the limit the issue needs a supervisor's approval, and the status is red.
    await invoiceOf(cust, '1000', { creditApprovalId: await approval('sales.credit_over_limit') });
    expect(await balance(accountant, cust)).toMatchObject({
      status: 'over_limit',
      amounts: { outstandingFils: '31500', availableFils: '-6500' },
    });
  });

  it('advance payments apart: never subtracted from outstanding, never added to the credit', async () => {
    const cust = await customer('Deposit payer', { credit: '100000' });
    await ok(
      accountant('POST', '/api/v1/sales/payments', {
        customerId: cust,
        part: cash('20000'),
        asAdvance: true,
      }),
      201,
    );
    await invoiceOf(cust, '1000'); // 105.00, not deducting the advance
    expect((await balance(accountant, cust)).amounts).toMatchObject({
      outstandingFils: '10500',
      advancesFils: '20000',
      netPositionFils: '-9500',
      availableFils: '89500',
    });
    const st = await ok<StatementResponse>(
      accountant('GET', `/api/v1/customers/${cust}/statement?from=2026-01-01&to=2099-12-31`),
    );
    expect(st.today).toEqual({
      outstandingFils: '10500',
      advancesFils: '20000',
      netPositionFils: '-9500',
    });
  });

  it('without customers.balance.view: the status only, never the amounts', async () => {
    const cust = await customer('Hidden amounts', { credit: '100000' });
    await invoiceOf(cust, '1000');
    expect(await balance(cashier, cust, true)).toEqual({
      status: 'within_limit',
      creditMode: 'credit',
      isWalkIn: false,
      amounts: null,
    });
  });

  it('a cash customer who owes is over the limit; the walk-in is marked', async () => {
    const cust = await customer('Cash owes');
    await invoiceOf(cust, '1000', { creditApprovalId: await approval('sales.credit_over_limit') });
    expect((await balance(cashier, cust)).status).toBe('over_limit');
    const walkIn = (
      await sql<{ id: string }>`SELECT id::text FROM md.customers WHERE is_walk_in`.execute(
        server.db,
      )
    ).rows[0]!.id;
    expect((await balance(cashier, walkIn)).isWalkIn).toBe(true);
  });

  it('the printed account summary: stored at issue, a reprint shows the same numbers', async () => {
    const cust = await customer('Printed balance', { credit: '100000' });
    await invoiceOf(cust, '1000'); // 105.00 owed before
    // 210.00, 50.00 of it paid at issue.
    phone += 1;
    const svc = await item(`B114-${phone}`, 'service', '1000000');
    const d = await draft(clerk, {
      customerId: cust,
      lines: [{ itemId: svc.id, quantityMilli: '2000' }],
    });
    const inv = await ok<DocumentDetail>(issue(accountant, d, { payments: [cash('5000')] }));
    const stored = (
      await sql<{ before: string; paid: string; credit: boolean }>`
        SELECT balance_before_fils::text AS before, paid_at_issue_fils::text AS paid,
               credit_customer AS credit
          FROM sales.documents WHERE id = ${BigInt(inv.id)}`.execute(server.db)
    ).rows[0]!;
    expect(stored).toEqual({ before: '10500', paid: '5000', credit: true });
    const block = async (id: string) =>
      /<div class="account">[\s\S]*?<\/div><\/div>/.exec(
        (await documentHtml(server.db, BigInt(id))).html,
      )?.[0] ?? null;
    const first = await block(inv.id);
    expect(first).toContain('Previous balance');
    expect(first).toContain('105.00 AED');
    expect(first).toContain('210.00 AED');
    expect(first).toContain('-50.00 AED'); // paid now
    expect(first).toContain('265.00 AED'); // total due = 105 + 210 − 50
    // Later payments change the balance, never what the invoice printed.
    await ok(
      accountant('POST', '/api/v1/sales/payments', { customerId: cust, part: cash('20000') }),
      201,
    );
    expect(await block(inv.id)).toBe(first);
    // The draft itself prints no summary (nothing is frozen until issue).
    const later = await draft(clerk, {
      customerId: cust,
      lines: [{ itemId: svc.id, quantityMilli: '1000' }],
    });
    expect(await block(later.id)).toBeNull();
  });

  it('the summary is for credit customers by default; the walk-in never has one', async () => {
    const cust = await customer('Cash printed');
    phone += 1;
    const svc = await item(`B114-${phone}`, 'service', '1000000');
    const d = await draft(clerk, {
      customerId: cust,
      lines: [{ itemId: svc.id, quantityMilli: '1000' }],
    });
    const inv = await ok<DocumentDetail>(issue(accountant, d, { payments: [cash('10500')] }));
    const html = (await documentHtml(server.db, BigInt(inv.id))).html;
    expect(html).not.toContain('Account summary');
    const walkIn = (
      await sql<{ id: string }>`SELECT id::text FROM md.customers WHERE is_walk_in`.execute(
        server.db,
      )
    ).rows[0]!.id;
    const w = await draft(clerk, {
      customerId: walkIn,
      lines: [{ itemId: svc.id, quantityMilli: '1000' }],
    });
    const sold = await ok<DocumentDetail>(issue(accountant, w, { payments: [cash('10500')] }));
    const rows = (
      await sql<{ id: string; before: string | null; credit: boolean | null }>`
        SELECT id::text, balance_before_fils::text AS before, credit_customer AS credit
          FROM sales.documents WHERE id IN (${BigInt(inv.id)}, ${BigInt(sold.id)}) ORDER BY id`.execute(
        server.db,
      )
    ).rows;
    expect(rows).toEqual([
      { id: inv.id, before: '0', credit: false },
      { id: sold.id, before: null, credit: null },
    ]);
  });

  it('the customers list: the column, the overdue filter, and sorting by amount with the permission', async () => {
    const late = await customer('Zz late payer', { credit: '100000' });
    await invoiceOf(late, '1000', { issueDate: await yesterday() }); // 30 days: not overdue yet
    const due = await yesterday();
    await ok(
      owner('POST', '/api/v1/customers/opening-balances', {
        customerId: late,
        direction: 'receivable',
        amountFils: '99000',
        dueDate: due,
      }),
      201,
    );
    const mine = (list: CustomerList) => list.customers.find((c) => c.id === late)!;
    const seen = await ok<CustomerList>(
      accountant('GET', '/api/v1/customers?balance=yes&q=late%20payer'),
    );
    expect(mine(seen).balance).toEqual({
      status: 'over_limit',
      outstandingFils: '109500',
      overdueFils: '99000',
    });
    const blind = await ok<CustomerList>(
      cashier('GET', '/api/v1/customers?balance=yes&q=late%20payer'),
    );
    expect(mine(blind).balance).toEqual({
      status: 'over_limit',
      outstandingFils: null,
      overdueFils: null,
    });
    // Without asking, no balance is worked out (the pickers stay fast).
    const plain = await ok<CustomerList>(accountant('GET', '/api/v1/customers?q=late%20payer'));
    expect(mine(plain).balance).toBeUndefined();
    const overdue = await ok<CustomerList>(
      accountant('GET', '/api/v1/customers?overdue=yes&pageSize=200'),
    );
    expect(overdue.customers.map((c) => c.id)).toContain(late);
    expect(overdue.customers.every((c) => !c.isWalkIn)).toBe(true);
    // Biggest first (other tests in this file leave customers owing more than this one).
    const sorted = await ok<CustomerList>(
      accountant('GET', '/api/v1/customers?sort=outstanding&pageSize=200'),
    );
    const amounts = sorted.customers.map((c) => BigInt(c.balance!.outstandingFils!));
    expect([...amounts].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))).toEqual(amounts);
    expect(amounts[0]).toBeGreaterThanOrEqual(109500n);
    expect(sorted.customers.map((c) => c.id)).toContain(late);
    expect(await refusal(cashier('GET', '/api/v1/customers?sort=outstanding'))).toMatchObject({
      status: 403,
    });
  });
});
