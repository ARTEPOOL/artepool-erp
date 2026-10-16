/**
 * M4b through the API: company bank accounts (owner only, UAE IBAN checked, decision 0065); the
 * print designer (owner only, versioned, stale saves refused, live preview, decision 0064); the
 * locked tax fields printed whatever the settings say; the customer PO number (0066); receipts
 * printed with the invoice design; the thermal receipt carrying its template.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BankAccount,
  BankAccountsResponse,
  CustomerDetail,
  DocumentDetail,
  ItemDetail,
  PreviewTemplateResponse,
  PrintTemplateItem,
  PrintTemplatesResponse,
  QuotationDetail,
  TemplateSettings,
} from '@artepool/shared/contracts';
import { documentHtml, receiptHtml } from '../../src/modules/printing/service';
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
const ids: Record<string, string> = {};
let phone = 3_000_000;
const IBAN = 'AE070331234567890123456';

function actor(device: TestDevice, token: string): Actor {
  return (method, url, body) =>
    call(server, method, url, {
      device,
      token,
      ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }),
      ...(body !== undefined ? { body } : {}),
    });
}

async function ok<T>(response: ReturnType<typeof call>, status = 200): Promise<T> {
  const r = await response;
  if (r.statusCode !== status) throw new Error(`${r.statusCode}: ${r.body}`);
  return r.json<T>();
}

async function refusal(response: ReturnType<typeof call>) {
  const r = await response;
  const body = r.json<{ error: { code: string; details: Record<string, unknown> } }>();
  return { status: r.statusCode, code: body.error?.code, ...body.error?.details };
}

async function customer(name: string, opts: { trn?: string; address?: string } = {}) {
  phone += 1;
  return ok<CustomerDetail>(
    owner('POST', '/api/v1/customers', {
      customerType: 'company',
      name,
      phone: `050 ${phone}`,
      isVatRegistered: opts.trn !== undefined,
      ...(opts.trn ? { trn: opts.trn } : {}),
      ...(opts.address ? { addressLine: opts.address } : {}),
    }),
    201,
  );
}

const templates = () => ok<PrintTemplatesResponse>(owner('GET', '/api/v1/print-templates'));
const template = async (kind: string) =>
  (await templates()).templates.find((t) => t.kind === kind)!;

async function save(kind: string, change: (s: TemplateSettings) => TemplateSettings) {
  const current = await template(kind);
  return ok<PrintTemplateItem>(
    owner('POST', `/api/v1/print-templates/${kind}/versions`, {
      settings: change(current.settings),
      basedOnVersionId: current.versionId,
    }),
    201,
  );
}

beforeAll(async () => {
  server = await startTestServer();
  const office = await addDevice(server, { code: 'OFFICE-PRINT' });
  const ownerId = await addOwner(server);
  owner = actor(
    office,
    (await openSession(server, { userId: ownerId, deviceId: office.id, method: 'password_totp' }))
      .token,
  );
  const pc = await addDevice(server, { code: 'OFFICE-ACC' });
  const accId = await addUser(server, { username: 'acc.print', roles: ['accountant'] });
  accountant = actor(pc, (await openSession(server, { userId: accId, deviceId: pc.id })).token);
  await ok(
    owner('PUT', '/api/v1/company', {
      legalNameAr: 'آرتي بول لحمامات السباحة',
      legalNameEn: 'ARTEPOOL Swimming Pools',
      vatRegistered: true,
      trn: '100123456789012',
      addressAr: 'العين، أبوظبي',
      addressEn: 'Al Ain, Abu Dhabi',
      phone: '03 000 0000',
    }),
  );
  const { rows } = await sql<{ kind: string; id: string }>`
    SELECT 'category' AS kind, id::text FROM md.item_categories WHERE code = 'PARTS'
    UNION ALL SELECT 'visit', id::text FROM md.units WHERE code = 'VISIT'
    UNION ALL SELECT 'vat', id::text FROM md.vat_categories WHERE code = 'SR'
    UNION ALL SELECT 'cash', id::text FROM md.payment_methods WHERE code = 'CASH'
  `.execute(server.db);
  for (const r of rows) ids[r.kind] ??= r.id;
  const svc = await ok<ItemDetail>(
    owner('POST', '/api/v1/items', {
      code: 'SRV-PRINT',
      itemType: 'service',
      nameAr: 'صيانة مسبح',
      nameEn: 'Pool service',
      categoryId: ids.category,
      unitId: ids.visit,
      vatCategoryId: ids.vat,
      price: { price4dp: '1000000', includesVat: false },
    }),
    201,
  );
  ids.service = svc.id;
});
afterAll(() => server.close());

describe('company bank accounts (decision 0065)', () => {
  it('owner only; a UAE IBAN with its checksum, saved without spaces; deactivated with a reason', async () => {
    const body = {
      bankName: 'Emirates NBD',
      accountName: 'ARTEPOOL',
      iban: 'ae07 0331 2345 6789 0123 456',
    };
    expect(await refusal(accountant('POST', '/api/v1/company/bank-accounts', body))).toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(
      await refusal(
        owner('POST', '/api/v1/company/bank-accounts', {
          ...body,
          iban: 'AE070331234567890123457',
        }),
      ),
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      issues: [{ path: ['iban'], code: 'invalid_iban' }],
    });
    expect(
      await refusal(owner('POST', '/api/v1/company/bank-accounts', { ...body, swift: 'EB' })),
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      issues: [{ path: ['swift'], code: 'invalid_swift' }],
    });
    const account = await ok<BankAccount>(
      owner('POST', '/api/v1/company/bank-accounts', { ...body, swift: 'ebilaead' }),
      201,
    );
    expect(account).toMatchObject({ iban: IBAN, swift: 'EBILAEAD', isActive: true });
    expect(await refusal(owner('POST', '/api/v1/company/bank-accounts', body))).toMatchObject({
      code: 'DUPLICATE',
      field: 'iban',
    });
    // Everyone signed in reads them (they print on invoices); only the owner edits.
    const list = await ok<BankAccountsResponse>(accountant('GET', '/api/v1/company/bank-accounts'));
    expect(list.canEdit).toBe(false);
    expect(list.accounts.map((a) => a.iban)).toContain(IBAN);
    ids.bank = account.id;
  });
});

describe('the print designer (decisions 0020, 0064)', () => {
  it('four templates; only the owner saves; a save makes a new version; a stale save is refused', async () => {
    const list = await templates();
    expect(list.canEdit).toBe(true);
    expect(list.templates.map((t) => t.kind)).toEqual([
      'tax_invoice_a4',
      'quotation_a4',
      'credit_note_a4',
      'receipt_thermal',
    ]);
    expect(list.bankAccounts.map((a) => a.id)).toContain(ids.bank);
    const before = await template('tax_invoice_a4');
    const settings = { ...before.settings, color: '#0a5c8a' };
    expect(
      await refusal(
        accountant('POST', '/api/v1/print-templates/tax_invoice_a4/versions', {
          settings,
          basedOnVersionId: before.versionId,
        }),
      ),
    ).toMatchObject({ status: 403 });
    const saved = await save('tax_invoice_a4', (s) => ({ ...s, color: '#0a5c8a' }));
    expect(saved.versionNo).toBe(before.versionNo + 1);
    expect(saved.settings.color).toBe('#0a5c8a');
    expect(
      await refusal(
        owner('POST', '/api/v1/print-templates/tax_invoice_a4/versions', {
          settings,
          basedOnVersionId: before.versionId,
        }),
      ),
    ).toMatchObject({ code: 'STALE_VERSION' });
    const audit = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM audit.log WHERE entity_type = 'sys.print_template_versions'
         AND entity_id = ${saved.versionId}`.execute(server.db);
    expect(audit.rows[0]!.n).toBe(1);
  });

  it('the preview prints the locked tax fields even with every optional field off', async () => {
    const current = await template('tax_invoice_a4');
    const allOff = {
      ...current.settings,
      fields: Object.fromEntries(Object.keys(current.settings.fields).map((k) => [k, false])),
    } as TemplateSettings;
    const { html } = await ok<PreviewTemplateResponse>(
      owner('POST', '/api/v1/print-templates/tax_invoice_a4/preview', { settings: allOff }),
    );
    // Seller name, address and TRN; customer name, address and TRN; the discount column (the
    // sample has a discount); VAT; totals.
    for (const text of [
      'ARTEPOOL Swimming Pools',
      'Al Ain, Abu Dhabi',
      '100123456789012',
      'Green Garden Contracting LLC',
      'المنطقة الصناعية، العين',
      '100234567800003',
      'Discount',
      'VAT',
      'Total payable',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain('PO-5531');
    expect(html).not.toContain('IBAN');
    expect(html).not.toContain('only'); // amount in words
  });

  it('optional fields print when on: PO, item code, amount in words, the chosen bank account', async () => {
    const current = await template('tax_invoice_a4');
    const settings: TemplateSettings = {
      ...current.settings,
      language: 'en',
      fields: {
        ...current.settings.fields,
        poNumber: true,
        itemCode: true,
        amountInWords: true,
        bankDetails: true,
      },
      bankAccountId: ids.bank!,
    };
    const { html } = await ok<PreviewTemplateResponse>(
      owner('POST', '/api/v1/print-templates/tax_invoice_a4/preview', { settings }),
    );
    expect(html).toContain('PO-5531');
    expect(html).toContain('PUMP-1HP');
    expect(html).toContain('Three thousand ninety-seven UAE dirhams and fifty fils only');
    expect(html).toContain('AE07 0331 2345 6789 0123 456');
    expect(html).not.toContain('فاتورة ضريبية'); // English only
    // The quotation is not a tax document: there, the seller's address can be hidden.
    const q = await template('quotation_a4');
    const quotation = await ok<PreviewTemplateResponse>(
      owner('POST', '/api/v1/print-templates/quotation_a4/preview', {
        settings: { ...q.settings, fields: { ...q.settings.fields, sellerAddress: false } },
      }),
    );
    expect(quotation.html).not.toContain('Al Ain, Abu Dhabi');
    // The thermal receipt is drawn by the PC: no HTML.
    const r = await template('receipt_thermal');
    expect(
      await ok<PreviewTemplateResponse>(
        owner('POST', '/api/v1/print-templates/receipt_thermal/preview', { settings: r.settings }),
      ),
    ).toEqual({ html: null });
  });
});

describe('printed documents (decisions 0064, 0066)', () => {
  it('a full tax invoice prints the customer address and PO; the stored version reprints unchanged', async () => {
    const c = await customer('Villa Contracting', {
      trn: '100555666700003',
      address: 'Falaj Hazza, Al Ain',
    });
    const draft = await ok<DocumentDetail>(
      owner('POST', '/api/v1/sales/invoices', {
        customerId: c.id,
        customerPo: 'PO-77',
        lines: [{ itemId: ids.service, quantityMilli: '1000' }],
      }),
      201,
    );
    expect(draft.customerPo).toBe('PO-77');
    // The customer address is switched off in the template: still printed on a full invoice.
    await save('tax_invoice_a4', (s) => ({
      ...s,
      fields: { ...s.fields, customerAddress: false, poNumber: true },
    }));
    const issued = await ok<DocumentDetail>(
      owner('POST', `/api/v1/sales/documents/${draft.id}/issue`, {
        rowVersion: draft.rowVersion,
        payments: [{ paymentMethodId: ids.cash, amountFils: '10500' }],
      }),
    );
    const first = await documentHtml(server.db, BigInt(issued.id));
    expect(first.html).toContain('Falaj Hazza, Al Ain');
    expect(first.html).toContain('PO-77');
    // A new design later does not change how this invoice reprints.
    await save('tax_invoice_a4', (s) => ({ ...s, fields: { ...s.fields, poNumber: false } }));
    expect((await documentHtml(server.db, BigInt(issued.id))).html).toContain('PO-77');
  });

  it('a full tax invoice for a customer without an address is refused at issue', async () => {
    const c = await customer('No Address LLC', { trn: '100555666700011' });
    const draft = await ok<DocumentDetail>(
      owner('POST', '/api/v1/sales/invoices', {
        customerId: c.id,
        lines: [{ itemId: ids.service, quantityMilli: '1000' }],
      }),
      201,
    );
    expect(
      await refusal(
        owner('POST', `/api/v1/sales/documents/${draft.id}/issue`, {
          rowVersion: draft.rowVersion,
          payments: [{ paymentMethodId: ids.cash, amountFils: '10500' }],
        }),
      ),
    ).toMatchObject({ code: 'RULE_VIOLATION', rule: 'FULL_INVOICE_ADDRESS' });
  });

  it('a quotation keeps its PO number when converted; a receipt prints with the invoice design', async () => {
    const c = await customer('Quote Customer');
    const q = await ok<QuotationDetail>(
      owner('POST', '/api/v1/sales/quotations', {
        customerId: c.id,
        customerPo: 'PO-Q1',
        lines: [{ itemId: ids.service, quantityMilli: '1000' }],
      }),
      201,
    );
    expect(q.customerPo).toBe('PO-Q1');
    const sent = await ok<QuotationDetail>(
      owner('POST', `/api/v1/sales/quotations/${q.id}/action`, {
        action: 'send',
        rowVersion: q.rowVersion,
      }),
    );
    const converted = await ok<DocumentDetail>(
      owner('POST', `/api/v1/sales/quotations/${q.id}/convert`, { rowVersion: sent.rowVersion }),
      201,
    );
    expect(converted.customerPo).toBe('PO-Q1');

    const { rows } = await sql<{ id: string; kind: string }>`
      SELECT p.id::text, t.doc_kind AS kind FROM sales.payments p
        JOIN sys.print_template_versions v ON v.id = p.print_template_version_id
        JOIN sys.print_templates t ON t.id = v.template_id
       ORDER BY p.id DESC LIMIT 1`.execute(server.db);
    expect(rows[0]!.kind).toBe('tax_invoice_a4');
    const receipt = await receiptHtml(server.db, BigInt(rows[0]!.id));
    expect(receipt.html).toContain('--main: #0a5c8a');
  });
});
