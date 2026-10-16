/**
 * M4-T11: the Quotations section (decisions 0045, 0049) against a scripted server: the list and
 * its filters, a new quotation with an optional line (shown, not counted; exact integer text in
 * the request), sending (with a supervisor's approval for a changed price), a new revision, the
 * conversion to an invoice draft, a translated refusal, no access, and Arabic right to left.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  BridgeRequest,
  CustomerListItem,
  ItemListItem,
  QuotationDetail,
  QuotationItem,
  SalesLine,
  UnitItem,
  VatResponse,
} from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { setLanguage } from '../../src/i18n';
import { addDays, dubaiDay } from '../../src/lib/format';
import {
  FakeBridge,
  failure,
  ok,
  sessionView,
  signInAnswer,
  userView,
} from '../support/fake-bridge';

// Start straight on a quotations page, and keep the router to read where the app went.
const start = vi.hoisted(() => ({
  path: '/',
  router: null as null | { state: { location: { pathname: string } } },
}));
vi.mock('../../src/app/router', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/app/router')>();
  return {
    ...original,
    createAppRouter: () => {
      const router = original.createAppRouter(start.path);
      start.router = router;
      return router;
    },
  };
});
// The print dialog itself belongs to Windows; here we only check the PDF reaches it.
const printed = vi.hoisted(() => ({ files: [] as unknown[] }));
vi.mock('../../src/features/sales/print', () => ({
  printPdf: (file: unknown) => {
    printed.files.push(file);
    return Promise.resolve();
  },
}));

const pathname = () => start.router?.state.location.pathname;
const TODAY = dubaiDay();

const UNITS: UnitItem[] = [
  {
    id: '1',
    code: 'PCS',
    nameAr: 'قطعة',
    nameEn: 'Piece',
    decimals: 0,
    einvoiceCode: null,
    isActive: true,
    rowVersion: 1,
  },
];

const VAT: VatResponse = {
  categories: [
    { id: '1', code: 'SR', nameAr: 'أساسي', nameEn: 'Standard', rateBp: 500, rowVersion: 1 },
  ],
  einvoiceMandatoryFrom: null,
};

const item = (patch: Partial<ItemListItem>): ItemListItem => ({
  id: '10',
  code: 'CHEM-0012',
  itemType: 'stock',
  nameAr: 'كلور حبيبات',
  nameEn: 'Granular chlorine',
  categoryId: '1',
  unitId: '1',
  vatCategoryId: '1',
  price: { price4dp: '1000000', includesVat: false },
  primaryBarcode: null,
  isSellable: true,
  isActive: true,
  ...patch,
});
const CHLORINE = item({});
const PUMP = item({
  id: '20',
  code: 'PUMP-0001',
  nameAr: 'مضخة',
  nameEn: 'Pool pump',
  price: { price4dp: '25000000', includesVat: false },
});

const HOTEL: CustomerListItem = {
  id: '12',
  code: 'C00012',
  customerType: 'company',
  name: 'Al Waha Hotel',
  nameAlt: null,
  phone: '+97137654321',
  isVatRegistered: true,
  trn: '100456789000003',
  creditMode: 'cash',
  isWalkIn: false,
  isActive: true,
};

const savedLine = (patch: Partial<SalesLine>): SalesLine => ({
  id: '501',
  lineNo: 1,
  lineKind: 'item',
  itemId: '10',
  itemCode: 'CHEM-0012',
  descriptionAr: 'كلور حبيبات',
  descriptionEn: 'Granular chlorine',
  unitId: '1',
  businessLineId: '1',
  quantityMilli: '2000',
  listPrice4dp: '1000000',
  unitPrice4dp: '1000000',
  priceIncludesVat: false,
  amountBeforeDiscountFils: '20000',
  lineDiscountFils: '0',
  docDiscountAllocFils: '0',
  discountExclVatFils: '0',
  netFils: '20000',
  vatCategoryId: '1',
  vatRateBp: 500,
  vatFils: '1000',
  grossFils: '21000',
  isOptional: false,
  note: null,
  ...patch,
});

const quotation = (patch: Partial<QuotationDetail> = {}): QuotationDetail => ({
  id: '51',
  docNumber: 'Q-000051',
  revision: 1,
  status: 'draft',
  customerId: '12',
  customerName: 'Al Waha Hotel',
  quotationDate: TODAY,
  validUntil: addDays(TODAY, 15),
  subject: 'Pool chemicals',
  convertedDocumentId: null,
  discountTotalFils: '0',
  netFils: '20000',
  vatFils: '1000',
  totalFils: '21000',
  rowVersion: 2,
  businessLineId: '1',
  billToName: 'Al Waha Hotel',
  billToTrn: '100456789000003',
  customerPo: null,
  termsAr: null,
  termsEn: 'Payment on delivery.',
  notes: null,
  docDiscountFils: '0',
  revisedFromId: null,
  revisions: [{ id: '51', revision: 1, status: 'draft' }],
  paymentsFils: '0',
  lines: [
    savedLine({}),
    savedLine({
      id: '502',
      lineNo: 2,
      itemId: '20',
      itemCode: 'PUMP-0001',
      descriptionAr: 'مضخة',
      descriptionEn: 'Pool pump',
      quantityMilli: '1000',
      listPrice4dp: '25000000',
      unitPrice4dp: '25000000',
      amountBeforeDiscountFils: '250000',
      netFils: '250000',
      vatFils: '12500',
      grossFils: '262500',
      isOptional: true,
    }),
  ],
  ...patch,
});

const listItem = (q: QuotationDetail): QuotationItem => ({
  id: q.id,
  docNumber: q.docNumber,
  revision: q.revision,
  status: q.status,
  customerId: q.customerId,
  customerName: q.customerName,
  quotationDate: q.quotationDate,
  validUntil: q.validUntil,
  subject: q.subject,
  convertedDocumentId: q.convertedDocumentId,
  discountTotalFils: q.discountTotalFils,
  netFils: q.netFils,
  vatFils: q.vatFils,
  totalFils: q.totalFils,
  rowVersion: q.rowVersion,
});

const MANAGER = ['quotations.manage', 'invoices.view', 'invoices.create', 'customers.view'];

function bridgeFor(permissions: string[], path: string) {
  start.path = path;
  start.router = null;
  printed.files = [];
  return new FakeBridge()
    .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer({}, { displayNameAr: 'محمد ياسر' })))
    .on(
      'GET',
      '/api/v1/auth/me',
      ok({
        session: sessionView(),
        user: userView({ displayNameAr: 'محمد ياسر', displayNameEn: 'Mohammed Yasser' }),
        device: { id: '2', code: 'OFFICE-01', name: 'Owner office', kind: 'office' },
        permissions,
      }),
    )
    .on('GET', '/api/v1/units', ok({ units: UNITS }))
    .on('GET', '/api/v1/settings/vat', ok(VAT))
    .on('GET', '/api/v1/customers', ok({ customers: [HOTEL], total: 1 }))
    .on('GET', '/api/v1/items', (request: BridgeRequest) => {
      const q = (new URLSearchParams(request.path.split('?')[1]).get('q') ?? '').toLowerCase();
      const items = [CHLORINE, PUMP].filter(
        (i) => i.nameEn.toLowerCase().includes(q) || i.nameAr.includes(q),
      );
      return ok({ items, total: items.length, counts: {}, exactMatchId: null });
    });
}

async function signIn(bridge: FakeBridge, heading: string | RegExp) {
  render(<App bridge={bridge} />);
  await screen.findByRole('heading', { level: 1 });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'blue-pool-water' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: heading, level: 1 });
}

async function inEnglish() {
  await act(() => setLanguage('en'));
}

/** The value next to a label in the totals box. */
const totalOf = (label: string) => {
  const dt = screen.getAllByText(label, { selector: 'dt' })[0]!;
  return dt.parentElement!.querySelector('dd')!.textContent;
};

async function addItem(name: string) {
  fireEvent.change(
    screen.getByRole('searchbox', { name: 'Search items by name, code or barcode' }),
    {
      target: { value: name },
    },
  );
  const results = await screen.findByRole('list', { name: 'Search results' });
  fireEvent.click(await within(results).findByRole('button', { name: new RegExp(name) }));
}

// ---------------------------------------------------------------------------------------------

describe('Quotations list', () => {
  it('shows number/revision, validity, total and status; filters by status and search', async () => {
    await inEnglish();
    const late = quotation({
      revision: 2,
      status: 'sent',
      validUntil: addDays(TODAY, -1),
      totalFils: '123456',
    });
    const accepted = quotation({
      id: '50',
      docNumber: 'Q-000050',
      status: 'accepted',
      customerName: 'Villa owner',
      subject: null,
    });
    const bridge = bridgeFor(MANAGER, '/quotations').on(
      'GET',
      '/api/v1/sales/quotations',
      (request: BridgeRequest) => {
        const params = new URLSearchParams(request.path.split('?')[1]);
        const list =
          params.get('status') === 'accepted'
            ? [accepted]
            : params.get('q') === 'villa'
              ? [accepted]
              : [late, accepted];
        return ok({ total: list.length, quotations: list.map(listItem) });
      },
    );
    await signIn(bridge, 'Quotations');
    const table = await screen.findByRole('table', { name: 'Quotations' });
    const lateRow = (await within(table).findByText('Q-000051/2')).closest('tr')!;
    expect(within(lateRow).getByText('Al Waha Hotel')).toBeTruthy();
    expect(within(lateRow).getByText('Pool chemicals')).toBeTruthy();
    expect(within(lateRow).getByText('Validity ended')).toBeTruthy();
    expect(within(lateRow).getByText('1,234.56')).toBeTruthy();
    expect(within(lateRow).getByText('Sent')).toBeTruthy();
    const acceptedRow = within(table).getByText('Q-000050').closest('tr')!;
    expect(within(acceptedRow).getByText('Accepted')).toBeTruthy();
    expect(within(acceptedRow).queryByText('Validity ended')).toBeNull();

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'accepted' } });
    await waitFor(() => expect(within(table).queryByText('Q-000051/2')).toBeNull());
    expect(
      bridge
        .callsTo('GET', '/api/v1/sales/quotations')
        .some((c) => c.path.includes('status=accepted')),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search by number, customer or subject' }),
      {
        target: { value: 'villa' },
      },
    );
    await waitFor(() =>
      expect(
        bridge.callsTo('GET', '/api/v1/sales/quotations').some((c) => c.path.includes('q=villa')),
      ).toBe(true),
    );

    bridge.on('GET', '/api/v1/sales/quotations/50', ok(accepted));
    fireEvent.click(await within(table).findByText('Q-000050'));
    await screen.findByRole('heading', { name: 'Quotation Q-000050', level: 1 });
    expect(pathname()).toBe('/quotations/50');
  });
});

describe('A new quotation', () => {
  it('an optional line is shown but not counted; saving sends exact integer text', async () => {
    await inEnglish();
    const created = quotation();
    const bridge = bridgeFor(MANAGER, '/quotations/new')
      .on('POST', '/api/v1/sales/quotations', ok(created, 201))
      .on('GET', '/api/v1/sales/quotations/51', ok(created));
    await signIn(bridge, 'New quotation');
    expect(screen.getByText(/Leave empty for the default: 15 days/)).toBeTruthy();

    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search customers by name, phone or TRN' }),
      { target: { value: 'waha' } },
    );
    const customers = await screen.findByRole('list', { name: 'Customers' });
    fireEvent.click(await within(customers).findByRole('button', { name: /Al Waha Hotel/ }));
    expect(await screen.findByText('Full tax invoice')).toBeTruthy();

    await addItem('Granular chlorine');
    await addItem('Pool pump');
    fireEvent.change(screen.getByLabelText('Quantity — Granular chlorine'), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByLabelText('Optional — Pool pump'));
    fireEvent.change(screen.getByLabelText('Discount on the total'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Pool chemicals' } });

    // 2 × 100.00 = 200.00 − 5.00 = 195.00 + 5% VAT 9.75 = 204.75; the pump (2,625.00) is left out.
    await waitFor(() => expect(totalOf('Total')).toBe('204.75'));
    expect(totalOf('Taxable amount')).toBe('195.00');
    expect(totalOf('VAT')).toBe('9.75');
    expect(screen.getByText('2,625.00')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save quotation' }));
    await screen.findByRole('heading', { name: 'Quotation Q-000051', level: 1 });
    expect(bridge.callsTo('POST', '/api/v1/sales/quotations')[0]!.body).toEqual({
      customerId: '12',
      quotationDate: TODAY,
      subject: 'Pool chemicals',
      docDiscountFils: '500',
      lines: [
        { itemId: '10', quantityMilli: '2000' },
        { itemId: '20', quantityMilli: '1000', isOptional: true },
      ],
    });
    expect(pathname()).toBe('/quotations/51');
    // The saved draft comes back into the editor, the optional line still marked.
    expect((await screen.findByLabelText<HTMLInputElement>('Optional — Pool pump')).checked).toBe(
      true,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Quantity — Granular chlorine').value).toBe('2');
  });

  it('a refused line is marked under the line', async () => {
    await inEnglish();
    const bridge = bridgeFor(MANAGER, '/quotations/new').on(
      'POST',
      '/api/v1/sales/quotations',
      failure(400, 'VALIDATION_FAILED', {
        part: 'body',
        issues: [{ path: ['lines.0.itemId'], code: 'not_for_sale' }],
      }),
    );
    await signIn(bridge, 'New quotation');
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search customers by name, phone or TRN' }),
      { target: { value: 'waha' } },
    );
    const customers = await screen.findByRole('list', { name: 'Customers' });
    fireEvent.click(await within(customers).findByRole('button', { name: /Al Waha Hotel/ }));
    await addItem('Granular chlorine');
    fireEvent.click(screen.getByRole('button', { name: 'Save quotation' }));
    expect(await screen.findByText(/This item cannot be sold now/)).toBeTruthy();
    expect(screen.getByText('Check the lines marked in red.')).toBeTruthy();
  });
});

describe('Sending, revising and converting', () => {
  it('send: the action body; a changed price gets a supervisor approval and is sent again', async () => {
    await inEnglish();
    const draft = quotation({
      lines: [savedLine({ unitPrice4dp: '900000' })],
    });
    const sent = quotation({ status: 'sent', rowVersion: 3, lines: draft.lines });
    let current = draft;
    const bridge = bridgeFor(MANAGER, '/quotations/51')
      .on('GET', '/api/v1/sales/quotations/51', () => ok(current))
      .on(
        'POST',
        '/api/v1/sales/quotations/51/action',
        failure(403, 'PERMISSION_DENIED', { rule: 'PRICE_OVERRIDE' }),
        () => {
          current = sent;
          return ok(sent);
        },
      )
      .on(
        'GET',
        '/api/v1/approvals/approvers',
        ok({ approvers: [{ id: '8', displayNameAr: 'خالد سالم', displayNameEn: 'Khalid Salem' }] }),
      )
      .on(
        'POST',
        '/api/v1/approvals',
        ok({ approvalId: '555', expiresAt: '2026-10-12T07:00:00Z' }),
      );
    await signIn(bridge, 'Quotation Q-000051');
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    const confirm = await screen.findByRole('dialog', { name: 'Send the quotation?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Send' }));

    const dialog = await screen.findByRole('dialog', { name: 'Price change approval' });
    await within(dialog).findByRole('option', { name: 'Khalid Salem' });
    fireEvent.change(within(dialog).getByLabelText('Supervisor'), { target: { value: '8' } });
    fireEvent.change(within(dialog).getByLabelText(/Supervisor's PIN/), {
      target: { value: '4826' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: 'Agreed project price' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('The quotation is sent.')).toBeTruthy();

    expect(bridge.callsTo('POST', '/api/v1/approvals')[0]!.body).toMatchObject({
      permission: 'sales.price_override',
      approverId: '8',
    });
    const actions = bridge.callsTo('POST', '/api/v1/sales/quotations/51/action');
    expect(actions.map((c) => c.body)).toEqual([
      { action: 'send', rowVersion: 2 },
      // A changed price has its own approval (a discount approval is a separate one).
      { action: 'send', rowVersion: 2, priceApprovalId: '555' },
    ]);
    // Now read-only, with the sent actions.
    expect(await screen.findByRole('button', { name: 'New revision' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Customer accepted' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('a sent quotation is read-only; the optional line is marked; a refusal is translated', async () => {
    await inEnglish();
    const sent = quotation({ status: 'sent' });
    const bridge = bridgeFor(MANAGER, '/quotations/51')
      .on('GET', '/api/v1/sales/quotations/51', ok(sent))
      .on(
        'POST',
        '/api/v1/sales/quotations/51/action',
        failure(409, 'RULE_VIOLATION', { rule: 'DOCUMENT_STEP' }),
      );
    await signIn(bridge, 'Quotation Q-000051');
    const lines = await screen.findByRole('table', { name: 'Lines' });
    const pumpRow = within(lines).getByText('Pool pump').closest('tr')!;
    expect(within(pumpRow).getByText('Optional')).toBeTruthy();
    expect(totalOf('Total')).toBe('210.00');
    expect(screen.getByText('Payment on delivery.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Customer accepted' }));
    const confirm = await screen.findByRole('dialog', { name: 'Customer accepted?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Mark as accepted' }));
    expect(
      await within(confirm).findByText(
        "This step is not possible in the document's current state.",
      ),
    ).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/sales/quotations/51/action')[0]!.body).toEqual({
      action: 'accept',
      rowVersion: 2,
    });
  });

  it('new revision: the same lines go to revise, and the app opens revision 2', async () => {
    await inEnglish();
    const sent = quotation({
      status: 'sent',
      revisions: [{ id: '51', revision: 1, status: 'sent' }],
    });
    const revision = quotation({
      id: '52',
      revision: 2,
      status: 'draft',
      revisedFromId: '51',
      rowVersion: 1,
      revisions: [
        { id: '51', revision: 1, status: 'superseded' },
        { id: '52', revision: 2, status: 'draft' },
      ],
    });
    const bridge = bridgeFor(MANAGER, '/quotations/51')
      .on('GET', '/api/v1/sales/quotations/51', ok(sent))
      .on('POST', '/api/v1/sales/quotations/51/revise', ok(revision, 201))
      .on('GET', '/api/v1/sales/quotations/52', ok(revision));
    await signIn(bridge, 'Quotation Q-000051');
    fireEvent.click(await screen.findByRole('button', { name: 'New revision' }));
    const confirm = await screen.findByRole('dialog', { name: 'Make a new revision?' });
    expect(within(confirm).getByText(/Revision 2 of Q-000051/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Make revision' }));

    await screen.findByRole('heading', { name: 'Quotation Q-000051/2', level: 1 });
    expect(pathname()).toBe('/quotations/52');
    expect(bridge.callsTo('POST', '/api/v1/sales/quotations/51/revise')[0]!.body).toEqual({
      customerId: '12',
      businessLineId: '1',
      subject: 'Pool chemicals',
      termsEn: 'Payment on delivery.',
      // The agreed prices travel with the revision, even if an item's price changed since.
      lines: [
        { itemId: '10', quantityMilli: '2000', unitPrice4dp: '1000000' },
        { itemId: '20', quantityMilli: '1000', isOptional: true, unitPrice4dp: '25000000' },
      ],
    });
    const history = screen.getByRole('list', { name: 'Revisions' });
    expect(within(history).getByRole('link', { name: 'Revision 1' })).toBeTruthy();
    expect(within(history).getByText('Replaced by a newer revision')).toBeTruthy();
  });

  it('convert: explains the kept prices, then opens the new invoice draft', async () => {
    await inEnglish();
    const accepted = quotation({ status: 'accepted', rowVersion: 4 });
    const bridge = bridgeFor(MANAGER, '/quotations/51')
      .on('GET', '/api/v1/sales/quotations/51', ok(accepted))
      .on('POST', '/api/v1/sales/quotations/51/convert', ok({ id: '77', status: 'draft' }, 201))
      .on(
        'GET',
        '/api/v1/sales/quotations/51/pdf',
        ok({ fileName: 'Q-000051.pdf', mime: 'application/pdf', dataBase64: 'JVBERg==' }),
      );
    await signIn(bridge, 'Quotation Q-000051');
    expect(screen.queryByRole('button', { name: 'New revision' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Print' }));
    await waitFor(() => expect(printed.files).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Convert to invoice' }));
    const confirm = await screen.findByRole('dialog', { name: 'Convert to an invoice?' });
    expect(within(confirm).getByText(/keeps the quotation's prices/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Convert to invoice' }));
    await waitFor(() => expect(pathname()).toBe('/invoices/77'));
    expect(bridge.callsTo('POST', '/api/v1/sales/quotations/51/convert')[0]!.body).toEqual({
      rowVersion: 4,
    });
  });

  it('without invoices.create there is no Convert button', async () => {
    await inEnglish();
    const bridge = bridgeFor(['quotations.manage'], '/quotations/51').on(
      'GET',
      '/api/v1/sales/quotations/51',
      ok(quotation({ status: 'accepted' })),
    );
    await signIn(bridge, 'Quotation Q-000051');
    expect(await screen.findByRole('button', { name: 'Cancel quotation' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Convert to invoice' })).toBeNull();
  });
});

describe('Access and Arabic', () => {
  it('without quotations.manage the pages say so and ask the server nothing', async () => {
    await inEnglish();
    const bridge = bridgeFor(['invoices.view'], '/quotations/51');
    await signIn(bridge, 'Quotations');
    expect(screen.getByText('You do not have permission to see this page.')).toBeTruthy();
    expect(bridge.callsTo('GET', '/api/v1/sales/quotations/51')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('works in Arabic, right to left: a draft is sent', async () => {
    let current = quotation();
    const bridge = bridgeFor(MANAGER, '/quotations/51')
      .on('GET', '/api/v1/sales/quotations/51', () => ok(current))
      .on('POST', '/api/v1/sales/quotations/51/action', () => {
        current = quotation({ status: 'sent', rowVersion: 3 });
        return ok(current);
      });
    render(<App bridge={bridge} />);
    await screen.findByRole('heading', { level: 1 });
    fireEvent.change(screen.getByLabelText('اسم المستخدم'), { target: { value: 'mohammed' } });
    fireEvent.change(screen.getByLabelText('كلمة المرور'), {
      target: { value: 'blue-pool-water' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    await screen.findByRole('heading', { name: 'عرض سعر Q-000051', level: 1 });
    expect(document.documentElement.dir).toBe('rtl');
    expect((await screen.findByLabelText<HTMLInputElement>('اختياري — مضخة')).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'إرسال' }));
    const confirm = await screen.findByRole('dialog', { name: 'إرسال العرض؟' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'إرسال' }));
    expect(await screen.findByText('أُرسل العرض.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/sales/quotations/51/action')[0]!.body).toEqual({
      action: 'send',
      rowVersion: 2,
    });
    expect(await screen.findByRole('button', { name: 'قبِل العميل' })).toBeTruthy();
  });
});
