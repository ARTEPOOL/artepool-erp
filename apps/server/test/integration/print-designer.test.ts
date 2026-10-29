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
  LabelDesignResponse,
  ReceiptLogoResponse,
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
import { defaultLabelDesign } from '@artepool/shared/contracts';
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
      email: 'office@artepool.test',
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

  it('the account summary (decision 0114): credit customers by default, every named customer, or off', async () => {
    const current = await template('tax_invoice_a4');
    expect(current.settings.balanceBlock).toBe('credit_customers');
    const preview = async (balanceBlock: TemplateSettings['balanceBlock'], language = 'en') =>
      (
        await ok<PreviewTemplateResponse>(
          owner('POST', '/api/v1/print-templates/tax_invoice_a4/preview', {
            settings: { ...current.settings, balanceBlock, language },
          }),
        )
      ).html!;
    // The sample customer is on credit: owed 1,250.00, this invoice 3,097.50, 1,000.00 paid now.
    const on = await preview('credit_customers');
    for (const text of [
      'Account summary',
      'Previous balance',
      '1,250.00 AED',
      'This invoice',
      'Paid now',
      '-1,000.00 AED',
      'Total due',
      '3,347.50 AED',
    ]) {
      expect(on).toContain(text);
    }
    expect(await preview('named_customers')).toContain('Account summary');
    expect(await preview('off')).not.toContain('Account summary');
    const ar = await preview('credit_customers', 'ar');
    expect(ar).toContain('ملخص الحساب');
    expect(ar).toContain('الرصيد السابق');
    expect(ar).toContain('إجمالي الرصيد المستحق');
    // The quotation never has one.
    const quotation = await template('quotation_a4');
    const q = await ok<PreviewTemplateResponse>(
      owner('POST', '/api/v1/print-templates/quotation_a4/preview', {
        settings: { ...quotation.settings, balanceBlock: 'named_customers' },
      }),
    );
    expect(q.html).not.toContain('Account summary');
  });

  it('logo in the middle, both languages: Arabic details on the right, English on the left', async () => {
    const current = await template('tax_invoice_a4');
    const { html } = await ok<PreviewTemplateResponse>(
      owner('POST', '/api/v1/print-templates/tax_invoice_a4/preview', {
        settings: { ...current.settings, language: 'both', logoPosition: 'center' },
      }),
    );
    const header = html!.slice(html!.indexOf('<header class="split">'), html!.indexOf('</header>'));
    const en = header.indexOf('seller-en');
    const ar = header.indexOf('seller-ar');
    expect(en).toBeGreaterThan(0);
    expect(ar).toBeGreaterThan(en);
    expect(header.slice(en, ar)).toContain('ARTEPOOL Swimming Pools');
    expect(header.slice(en, ar)).toContain('Al Ain, Abu Dhabi');
    expect(header.slice(ar)).toContain('الرقم الضريبي');
    // Name, address, phone, email, then the TRN, each labelled, in both columns.
    const withContact = (
      await ok<PreviewTemplateResponse>(
        owner('POST', '/api/v1/print-templates/tax_invoice_a4/preview', {
          settings: {
            ...current.settings,
            language: 'both',
            logoPosition: 'center',
            fields: { ...current.settings.fields, sellerContact: true },
          },
        }),
      )
    ).html!;
    const split = withContact.slice(
      withContact.indexOf('<header'),
      withContact.indexOf('</header>'),
    );
    const middle = split.indexOf('seller-ar');
    for (const [side, address] of [
      [split.slice(0, middle), 'Al Ain, Abu Dhabi'],
      [split.slice(middle), 'العين، أبوظبي'],
    ] as const) {
      const order = [address, '+97130000000', 'office@artepool.test', '100123456789012'].map(
        (text) => side.indexOf(text),
      );
      expect(order.every((at) => at > 0)).toBe(true);
      expect([...order].sort((x, y) => x - y)).toEqual(order);
    }
    expect(split).toContain('<span class="label">Phone:</span>');
    expect(split).toContain('<span class="label">رقم الهاتف:</span>');
    // The name stands alone, without a label.
    expect(split).not.toContain('اسم الشركة');
    expect(split).toContain('<h1>ARTEPOOL Swimming Pools</h1>');
    expect(header.slice(ar)).toContain('100123456789012');
    // One language only: the logo stays above the details, centred.
    const single = await ok<PreviewTemplateResponse>(
      owner('POST', '/api/v1/print-templates/tax_invoice_a4/preview', {
        settings: { ...current.settings, language: 'en', logoPosition: 'center' },
      }),
    );
    expect(single.html).toContain('<header class="center">');
    // Logo beside, both languages: the earlier block without labels (the owner's sample).
    const beside = (
      await ok<PreviewTemplateResponse>(
        owner('POST', '/api/v1/print-templates/tax_invoice_a4/preview', {
          settings: { ...current.settings, language: 'both', logoPosition: 'beside' },
        }),
      )
    ).html!;
    const block = beside.slice(beside.indexOf('<header'), beside.indexOf('</header>'));
    expect(block).not.toContain('class="label"');
    expect(block).toContain('<p>العين، أبوظبي</p><p>Al Ain, Abu Dhabi</p>');
    // Arabic label on the right, "TRN:" on the left, the number between them.
    expect(block).toContain(
      '<span class="pair">الرقم الضريبي:</span> <span class="ltr">TRN: 100123456789012</span>',
    );
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
  it('a full tax invoice prints the customer address and PO; a reprint uses today’s design (0071)', async () => {
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
    // A reprint follows today's design (0071); the stored version stays for the record.
    await save('tax_invoice_a4', (s) => ({ ...s, fields: { ...s.fields, poNumber: false } }));
    const reprint = (await documentHtml(server.db, BigInt(issued.id))).html;
    expect(reprint).not.toContain('PO-77');
    expect(reprint).toContain('Falaj Hazza, Al Ain');
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

describe('the thermal receipt’s own logo (decision 0075)', () => {
  // A 1×1 PNG.
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  it('the owner sets it; the receipt prints it, else the company logo; nobody else changes it', async () => {
    const before = await ok<ReceiptLogoResponse>(
      accountant('GET', '/api/v1/print-templates/receipt-logo'),
    );
    expect(before.own).toBe(false);
    const body = { logo: { type: 'image/png', dataBase64: PNG } };
    expect((await accountant('PUT', '/api/v1/print-templates/receipt-logo', body)).statusCode).toBe(
      403,
    );
    // A file that is not the PNG it claims to be is refused.
    expect(
      await refusal(
        owner('PUT', '/api/v1/print-templates/receipt-logo', {
          logo: { type: 'image/png', dataBase64: Buffer.from('not a png').toString('base64') },
        }),
      ),
    ).toMatchObject({ rule: 'LOGO_INVALID' });
    const set = await ok<ReceiptLogoResponse>(
      owner('PUT', '/api/v1/print-templates/receipt-logo', body),
    );
    expect(set).toMatchObject({ own: true, logo: { type: 'image/png', dataBase64: PNG } });
    expect((await templates()).hasReceiptLogo).toBe(true);
    // Back to the company logo.
    const cleared = await ok<ReceiptLogoResponse>(
      owner('PUT', '/api/v1/print-templates/receipt-logo', { logo: null }),
    );
    expect(cleared.own).toBe(false);
    expect(cleared.logo).toEqual(before.logo);
  });
});

describe('the barcode label design (decision 0097)', () => {
  it('everyone reads it; the owner saves versions; the minimum barcode cannot be designed away', async () => {
    const first = await ok<LabelDesignResponse>(accountant('GET', '/api/v1/label-design'));
    expect(first.canEdit).toBe(false);
    expect(first.design).toEqual(defaultLabelDesign());
    expect(first.shopName).toEqual({
      ar: 'آرتي بول لحمامات السباحة',
      en: 'ARTEPOOL Swimming Pools',
    });

    const design = defaultLabelDesign();
    design.elements.nameEn = { ...design.elements.nameEn, show: true };
    design.overrides['40X30'] = { elements: { nameEn: { show: false } } };
    // Not the owner: refused.
    expect(
      await refusal(
        accountant('POST', '/api/v1/label-design/versions', {
          design,
          basedOnVersionId: first.versionId,
        }),
      ),
    ).toMatchObject({ status: 403 });
    // Bars below 5 mm: refused by the contract.
    expect(
      await refusal(
        owner('POST', '/api/v1/label-design/versions', {
          design: { ...design, barcode: { ...design.barcode, heightMm: 4 } },
          basedOnVersionId: first.versionId,
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    const saved = await ok<LabelDesignResponse>(
      owner('POST', '/api/v1/label-design/versions', {
        design,
        note: 'English name',
        basedOnVersionId: first.versionId,
      }),
      201,
    );
    expect(saved.versionNo).toBe(first.versionNo + 1);
    expect(saved.design).toEqual(design);
    expect(
      (await ok<LabelDesignResponse>(accountant('GET', '/api/v1/label-design'))).design,
    ).toEqual(design);
    // Saving over a newer version: refused.
    expect(
      await refusal(
        owner('POST', '/api/v1/label-design/versions', {
          design,
          basedOnVersionId: first.versionId,
        }),
      ),
    ).toMatchObject({ code: 'STALE_VERSION' });
  });
});
