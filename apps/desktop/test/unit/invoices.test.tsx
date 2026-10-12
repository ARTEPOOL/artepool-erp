/**
 * M4-T10: the Invoices (A4) section against a scripted server: the list and its filters, a new
 * draft (VAT preview per line, exact integer text in the saved body), issuing with a split
 * payment, the supervisor's approval for a discount above the limit and for credit (decision
 * 0046), an issued final invoice with earlier payments deducted (0013) and printing (0008), a
 * credit note returning goods as defective (0015), no access, and one flow in Arabic.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  BridgeRequest,
  CustomerListItem,
  DocumentDetail,
  DocumentItem,
  ItemListItem,
  ReasonCodeItem,
  SalesLine,
  SalesPaymentMethod,
  UnitItem,
  VatResponse,
} from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { initI18n } from '../../src/i18n';
import {
  FakeBridge,
  failure,
  ok,
  sessionView,
  signInAnswer,
  userView,
} from '../support/fake-bridge';

const start = vi.hoisted(() => ({ path: '/' }));
vi.mock('../../src/app/router', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/app/router')>();
  return { ...original, createAppRouter: () => original.createAppRouter(start.path) };
});

// The print dialog cannot open in tests: record what would be printed.
const printed = vi.hoisted(() => ({ files: [] as unknown[] }));
vi.mock('../../src/features/sales/print', () => ({
  printPdf: (file: unknown) => {
    printed.files.push(file);
    return Promise.resolve();
  },
}));

// ---------------------------------------------------------------------------------------------
// Reference data

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
    { id: '1', code: 'SR', nameAr: 'نسبة أساسية', nameEn: 'Standard', rateBp: 500, rowVersion: 1 },
  ],
  einvoiceMandatoryFrom: null,
};

const PUMP: ItemListItem = {
  id: '10',
  code: 'PUMP-01',
  itemType: 'stock',
  nameAr: 'مضخة مسبح',
  nameEn: 'Pool pump',
  categoryId: '1',
  unitId: '1',
  vatCategoryId: '1',
  price: { price4dp: '1250000', includesVat: false },
  primaryBarcode: null,
  isSellable: true,
  isActive: true,
};

const CUSTOMER: CustomerListItem = {
  id: '20',
  code: 'C-0020',
  customerType: 'company',
  name: 'Blue Lagoon Villas',
  nameAlt: null,
  phone: '+971501234567',
  isVatRegistered: true,
  trn: '100123456700003',
  creditMode: 'cash',
  isWalkIn: false,
  isActive: true,
};

const METHODS: SalesPaymentMethod[] = [
  {
    id: '1',
    code: 'CASH',
    nameAr: 'نقدًا',
    nameEn: 'Cash',
    kind: 'cash',
    requiresReference: false,
    givesChange: true,
  },
  {
    id: '2',
    code: 'CARD',
    nameAr: 'بطاقة',
    nameEn: 'Card',
    kind: 'card',
    requiresReference: true,
    givesChange: false,
  },
];

const REASONS: ReasonCodeItem[] = [
  {
    id: '61',
    category: 'credit_note',
    code: 'RETURN',
    nameAr: 'إرجاع بضاعة',
    nameEn: 'Goods returned',
    requiresNote: false,
    glAccountId: null,
    isActive: true,
    rowVersion: 1,
  },
  {
    id: '62',
    category: 'debit_note',
    code: 'EXTRA_WORK',
    nameAr: 'أعمال إضافية',
    nameEn: 'Extra work',
    requiresNote: true,
    glAccountId: null,
    isActive: true,
    rowVersion: 1,
  },
];

// ---------------------------------------------------------------------------------------------
// Documents

const line = (patch: Partial<SalesLine>): SalesLine => ({
  id: '501',
  lineNo: 1,
  lineKind: 'item',
  itemId: '10',
  itemCode: 'PUMP-01',
  descriptionAr: 'مضخة مسبح',
  descriptionEn: 'Pool pump',
  unitId: '1',
  businessLineId: '1',
  quantityMilli: '2000',
  listPrice4dp: '1250000',
  unitPrice4dp: '1250000',
  priceIncludesVat: false,
  amountBeforeDiscountFils: '25000',
  lineDiscountFils: '0',
  docDiscountAllocFils: '0',
  discountExclVatFils: '0',
  netFils: '25000',
  vatCategoryId: '1',
  vatRateBp: 500,
  vatFils: '1250',
  grossFils: '26250',
  advanceDocumentId: null,
  advanceDocumentNumber: null,
  originalLineId: null,
  returnStockStatus: null,
  creditedMilli: '0',
  note: null,
  ...patch,
});

const item = (patch: Partial<DocumentItem>): DocumentItem => ({
  id: '101',
  docType: 'invoice',
  invoiceFormat: 'full',
  status: 'issued',
  docNumber: 'INV-000101',
  channel: 'office',
  customerId: '20',
  customerName: 'Blue Lagoon Villas',
  issueDate: '2026-10-10',
  dueDate: null,
  discountTotalFils: '0',
  netFils: '25000',
  vatFils: '1250',
  totalFils: '26250',
  settledFils: '10000',
  settlementStatus: 'partial',
  originalDocumentId: null,
  originalDocumentNumber: null,
  quotationId: null,
  printCount: 0,
  rowVersion: 2,
  ...patch,
});

const detail = (patch: Partial<DocumentDetail>): DocumentDetail => ({
  ...item({}),
  businessLineId: '1',
  billToName: 'Blue Lagoon Villas',
  billToNameAlt: null,
  billToTrn: '100123456700003',
  billToAddress: 'Al Jimi, Al Ain',
  billToPhone: '+971501234567',
  supplyDate: null,
  issuedAt: '2026-10-10T06:00:00.000Z',
  issuedByName: { displayNameAr: 'سالم', displayNameEn: 'Salem' },
  docDiscountFils: '0',
  reasonCodeId: null,
  reasonText: null,
  notes: null,
  internalNote: null,
  journalEntryId: '900',
  lines: [line({})],
  settlements: [
    { kind: 'payment', id: '70', docNumber: 'RCT-000070', date: '2026-10-10', amountFils: '10000' },
  ],
  ...patch,
});

/** The draft the new-invoice test saves: 2 pumps, 10% off, 5.00 off the total. */
const DRAFT = detail({
  id: '300',
  status: 'draft',
  docNumber: null,
  issueDate: null,
  issuedAt: null,
  issuedByName: null,
  billToTrn: null,
  journalEntryId: null,
  settlements: [],
  settledFils: '0',
  settlementStatus: 'open',
  discountTotalFils: '3000',
  docDiscountFils: '500',
  netFils: '22000',
  vatFils: '1100',
  totalFils: '23100',
  rowVersion: 3,
  lines: [
    line({
      lineDiscountFils: '2500',
      docDiscountAllocFils: '500',
      netFils: '22000',
      vatFils: '1100',
      grossFils: '23100',
    }),
  ],
  deductible: [],
});

const ISSUED_300 = detail({
  ...DRAFT,
  status: 'issued',
  docNumber: 'INV-000300',
  issueDate: '2026-10-12',
  issuedAt: '2026-10-12T07:00:00.000Z',
  billToTrn: '100123456700003',
  rowVersion: 4,
});

// ---------------------------------------------------------------------------------------------
// The scripted server

function bridgeFor(permissions: string[], path: string) {
  start.path = path;
  return new FakeBridge()
    .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer({}, { displayNameEn: 'Mona Saeed' })))
    .on(
      'GET',
      '/api/v1/auth/me',
      ok({
        session: sessionView(),
        user: userView({ displayNameAr: 'منى سعيد', displayNameEn: 'Mona Saeed' }),
        device: { id: '2', code: 'OFFICE-01', name: 'Owner office', kind: 'office' },
        permissions,
      }),
    )
    .on('GET', '/api/v1/units', ok({ units: UNITS }))
    .on('GET', '/api/v1/settings/vat', ok(VAT))
    .on('GET', '/api/v1/reason-codes', ok({ reasonCodes: REASONS }))
    .on('GET', '/api/v1/sales/payment-methods', ok({ paymentMethods: METHODS }))
    .on(
      'GET',
      '/api/v1/items',
      ok({
        items: [PUMP],
        total: 1,
        counts: { active: 1, stock: 1, service: 0, bundle: 0 },
        exactMatchId: null,
      }),
    )
    .on(
      'GET',
      '/api/v1/customers',
      ok({ customers: [CUSTOMER], total: 1, counts: { active: 1, vatRegistered: 1 } }),
    )
    .on(
      'GET',
      '/api/v1/customers/20/balance',
      ok({ balanceFils: '0', creditMode: 'cash', creditLimitFils: '0', advancesFils: '0' }),
    )
    .on(
      'GET',
      '/api/v1/customers/20',
      ok({
        ...CUSTOMER,
        phoneAlt: null,
        email: null,
        addressLine: null,
        area: null,
        city: null,
        poBox: null,
        emirate: null,
        countryCode: 'AE',
        paymentTermsDays: 0,
        creditLimitFils: '0',
        preferredLanguage: null,
        notes: null,
        rowVersion: 1,
      }),
    )
    .on('GET', '/api/v1/sales/documents', ok({ documents: [], total: 0 }))
    .on('GET', '/api/v1/approvals/approvers', ok({ approvers: [APPROVER] }));
}

const APPROVER = { id: '8', displayNameAr: 'خالد سالم', displayNameEn: 'Khalid Salem' };

async function signIn(bridge: FakeBridge, heading: string, language: 'en' | 'ar' = 'en') {
  await initI18n(language);
  render(<App bridge={bridge} />);
  await screen.findByRole('heading', { level: 1 });
  const en = language === 'en';
  fireEvent.change(screen.getByLabelText(en ? 'Username' : 'اسم المستخدم'), {
    target: { value: 'mona' },
  });
  fireEvent.change(screen.getByLabelText(en ? 'Password' : 'كلمة المرور'), {
    target: { value: 'blue-pool-water' },
  });
  fireEvent.click(screen.getByRole('button', { name: en ? 'Sign in' : 'دخول' }));
  await screen.findByRole('heading', { name: heading, level: 1 });
}

/** A supervisor approves in the dialog that is open. */
async function approve(reason: string) {
  const dialog = await screen.findByRole('dialog', { name: /approval/i });
  await within(dialog).findByRole('option', { name: 'Khalid Salem' });
  fireEvent.change(within(dialog).getByLabelText('Supervisor'), { target: { value: '8' } });
  fireEvent.change(within(dialog).getByLabelText(/Supervisor's PIN/), {
    target: { value: '4826' },
  });
  fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: reason } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
}

const queryOf = (request: BridgeRequest) => new URLSearchParams(request.path.split('?')[1]);

const OFFICE = [
  'invoices.view',
  'invoices.create',
  'invoices.issue',
  'payments.receive',
  'customers.view',
  'credit_notes.issue',
];

// ---------------------------------------------------------------------------------------------

describe('Invoices (A4): the list', () => {
  it('filters by type, status, payment and search, and a row opens the document', async () => {
    const LIST = [
      item({}),
      item({
        id: '102',
        status: 'draft',
        docNumber: null,
        issueDate: null,
        settledFils: '0',
        settlementStatus: 'open',
      }),
      item({
        id: '103',
        docType: 'credit_note',
        docNumber: 'CN-000004',
        totalFils: '5250',
        settledFils: '5250',
        settlementStatus: 'settled',
      }),
    ];
    const bridge = bridgeFor(OFFICE, '/invoices')
      .on('GET', '/api/v1/sales/documents', ok({ documents: LIST, total: 3 }))
      .on('GET', '/api/v1/sales/documents/101', ok(detail({})));
    await signIn(bridge, 'A4 invoices');

    const table = await screen.findByRole('table', { name: 'Invoices and notes' });
    const first = (await within(table).findByText('INV-000101')).closest('tr')!;
    expect(within(first).getByText('Tax invoice')).toBeTruthy();
    expect(within(first).getByText('262.50')).toBeTruthy();
    expect(within(first).getByText('100.00')).toBeTruthy();
    expect(within(first).getByText('Due 162.50')).toBeTruthy();
    expect(within(first).getByText('Issued')).toBeTruthy();
    expect(within(first).getByText('Partly paid')).toBeTruthy();
    const draft = within(table).getByText('Draft (no number yet)').closest('tr')!;
    expect(within(draft).getByText('Draft')).toBeTruthy();
    const note = within(table).getByText('CN-000004').closest('tr')!;
    expect(within(note).getByText('Credit note')).toBeTruthy();
    expect(within(note).getByText('Paid')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New invoice' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'credit_note' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'issued' } });
    fireEvent.change(screen.getByLabelText('Payment'), { target: { value: 'partial' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Number or customer' }), {
      target: { value: 'Lagoon' },
    });
    await waitFor(() => {
      const last = bridge.callsTo('GET', '/api/v1/sales/documents').at(-1)!;
      expect(Object.fromEntries(queryOf(last))).toEqual({
        pageSize: '100',
        q: 'Lagoon',
        docType: 'credit_note',
        status: 'issued',
        settlement: 'partial',
      });
    });

    fireEvent.click(within(table).getByText('INV-000101'));
    await screen.findByRole('heading', { name: 'INV-000101', level: 1 });
  });

  it('shows the empty state when nothing matches', async () => {
    const bridge = bridgeFor(OFFICE, '/invoices');
    await signIn(bridge, 'A4 invoices');
    expect(await screen.findByText('No documents match these filters.')).toBeTruthy();
  });

  it('without invoices.view: no list, no call, the no-access message', async () => {
    const bridge = bridgeFor(['customers.view'], '/invoices');
    await signIn(bridge, 'A4 invoices');
    expect(screen.getByText('You do not have permission to see this page.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New invoice' })).toBeNull();
    expect(bridge.callsTo('GET', '/api/v1/sales/documents')).toHaveLength(0);
  });
});

describe('Invoices (A4): a new invoice', () => {
  it('picks the customer and a line, previews VAT per line, and saves exact integer text', async () => {
    const bridge = bridgeFor(OFFICE, '/invoices/new')
      .on('POST', '/api/v1/sales/invoices', ok(DRAFT, 201))
      .on('GET', '/api/v1/sales/documents/300', ok(DRAFT));
    await signIn(bridge, 'New tax invoice');

    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search customers by name, phone or TRN' }),
      { target: { value: 'Lagoon' } },
    );
    const customers = await screen.findByRole('list', { name: 'Customers' });
    fireEvent.click(await within(customers).findByRole('button', { name: /Blue Lagoon Villas/ }));
    expect(
      await screen.findByText('The customer is VAT-registered: a full tax invoice with their TRN.'),
    ).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: /Search items/ }), {
      target: { value: 'pump' },
    });
    const results = await screen.findByRole('list', { name: 'Search results' });
    fireEvent.click(await within(results).findByRole('button', { name: /Pool pump/ }));

    fireEvent.change(await screen.findByLabelText('Quantity — Pool pump'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('Discount % — Pool pump'), { target: { value: '10' } });
    const lines = screen.getByRole('table', { name: 'Lines' });
    // 2 × 125.00 = 250.00, 10% off → 225.00 before VAT, VAT 5% = 11.25, total 236.25.
    await waitFor(() => expect(within(lines).getByText('225.00')).toBeTruthy());
    expect(within(lines).getByText('11.25')).toBeTruthy();
    expect(within(lines).getByText('236.25')).toBeTruthy();

    // 5.00 off the total: 220.00 + VAT 11.00 = 231.00.
    fireEvent.change(screen.getByLabelText(/Discount on the total/), { target: { value: '5' } });
    const totals = await screen.findByText('Taxable amount');
    const box = totals.closest('dl')!;
    await waitFor(() => expect(within(box).getByText('220.00')).toBeTruthy());
    expect(within(box).getByText('11.00')).toBeTruthy();
    expect(within(box).getByText('231.00')).toBeTruthy();

    // Not saved yet: it cannot be issued.
    expect(
      screen.getByRole('button', { name: 'Issue invoice' }).hasAttribute('data-disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByRole('heading', { name: 'Invoice draft', level: 1 });

    const post = bridge.callsTo('POST', '/api/v1/sales/invoices')[0]!;
    expect(post.body).toEqual({
      customerId: '20',
      docDiscountFils: '500',
      lines: [{ itemId: '10', quantityMilli: '2000', lineDiscountBp: 1000 }],
    });
    expect(post.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // The saved draft is unchanged, so it may be issued now.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Issue invoice' }).hasAttribute('data-disabled'),
      ).toBe(false),
    );
  });

  it('a saved draft is updated with PUT and its row version; earlier payments are deducted', async () => {
    const ADVANCE = item({
      id: '201',
      docType: 'advance_invoice',
      docNumber: 'INV-000201',
      netFils: '3000000',
      vatFils: '150000',
      totalFils: '3150000',
      settledFils: '3150000',
      settlementStatus: 'settled',
      advanceLeftNetFils: '3000000',
      advanceLeftVatFils: '150000',
    });
    const bridge = bridgeFor(OFFICE, '/invoices/300')
      .on('GET', '/api/v1/sales/documents/300', ok(DRAFT))
      .on('GET', '/api/v1/sales/documents', (request: BridgeRequest) =>
        queryOf(request).get('docType') === 'advance_invoice'
          ? ok({ documents: [ADVANCE], total: 1 })
          : ok({ documents: [], total: 0 }),
      )
      .on('PUT', '/api/v1/sales/invoices/300', ok({ ...DRAFT, rowVersion: 4 }));
    await signIn(bridge, 'Invoice draft');

    const advances = await screen.findByRole('list', { name: 'Earlier payments to deduct' });
    expect(within(advances).getByText('Left to deduct: 31,500.00')).toBeTruthy();
    fireEvent.click(within(advances).getByRole('checkbox', { name: 'Deduct INV-000201' }));
    expect(await screen.findByText('Less: earlier payments')).toBeTruthy();
    expect(screen.getByText('-31,500.00')).toBeTruthy();
    expect(screen.getByText('Save the draft before issuing it.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft saved.');
    expect(bridge.callsTo('PUT', '/api/v1/sales/invoices/300')[0]!.body).toEqual({
      customerId: '20',
      docDiscountFils: '500',
      lines: [{ itemId: '10', quantityMilli: '2000', lineDiscountFils: '2500' }],
      deductions: [{ advanceDocumentId: '201' }],
      rowVersion: 3,
    });
  });

  it('discarding a draft asks first, then sends its row version', async () => {
    const bridge = bridgeFor(OFFICE, '/invoices/300')
      .on('GET', '/api/v1/sales/documents/300', ok(DRAFT))
      .on('POST', '/api/v1/sales/documents/300/discard', ok({ ...DRAFT, status: 'discarded' }));
    await signIn(bridge, 'Invoice draft');
    fireEvent.click(await screen.findByRole('button', { name: 'Discard draft' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard this draft?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await screen.findByRole('heading', { name: 'A4 invoices', level: 1 });
    expect(bridge.callsTo('POST', '/api/v1/sales/documents/300/discard')[0]!.body).toEqual({
      rowVersion: 3,
    });
  });
});

describe('Invoices (A4): issuing', () => {
  it('issues with a split payment: cash and card with its reference', async () => {
    const bridge = bridgeFor(OFFICE, '/invoices/300')
      .on('GET', '/api/v1/sales/documents/300', ok(DRAFT))
      .on('POST', '/api/v1/sales/documents/300/issue', ok(ISSUED_300));
    await signIn(bridge, 'Invoice draft');
    fireEvent.click(await screen.findByRole('button', { name: 'Issue invoice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue the invoice' });
    expect(within(dialog).getByTestId('issue-due').textContent).toBe('231.00');
    await waitFor(() =>
      expect(bridge.callsTo('GET', '/api/v1/sales/payment-methods')).not.toHaveLength(0),
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a payment' }));
    const first = await within(dialog).findByRole('group', { name: 'Payment 1' });
    expect(within(first).getByLabelText<HTMLInputElement>('Amount').value).toBe('231.00');
    fireEvent.change(within(first).getByLabelText('Amount'), { target: { value: '100' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a payment' }));
    const second = await within(dialog).findByRole('group', { name: 'Payment 2' });
    expect(within(second).getByLabelText<HTMLInputElement>('Amount').value).toBe('131.00');
    fireEvent.change(within(second).getByLabelText('Payment method'), { target: { value: '2' } });
    fireEvent.change(within(second).getByLabelText('Reference'), { target: { value: 'AUTH-77' } });
    expect(within(dialog).getByText('0.00')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Issue' }));
    await screen.findByRole('heading', { name: 'INV-000300', level: 1 });
    expect(bridge.callsTo('POST', '/api/v1/sales/documents/300/issue')[0]!.body).toEqual({
      rowVersion: 3,
      payments: [
        { paymentMethodId: '1', amountFils: '10000' },
        { paymentMethodId: '2', amountFils: '13100', reference: 'AUTH-77' },
      ],
    });
  });

  it('a discount above the limit: the supervisor approves and the issue is sent again', async () => {
    const bridge = bridgeFor(OFFICE, '/invoices/300')
      .on('GET', '/api/v1/sales/documents/300', ok(DRAFT))
      .on(
        'POST',
        '/api/v1/sales/documents/300/issue',
        failure(403, 'RULE_VIOLATION', { rule: 'DISCOUNT_OVER_LIMIT' }),
        ok(ISSUED_300),
      )
      .on(
        'POST',
        '/api/v1/approvals',
        ok({ approvalId: '555', expiresAt: '2026-10-12T09:00:00Z' }),
      );
    await signIn(bridge, 'Invoice draft');
    fireEvent.click(await screen.findByRole('button', { name: 'Issue invoice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue the invoice' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Issue' }));

    expect(await screen.findByRole('dialog', { name: 'Discount approval' })).toBeTruthy();
    expect(
      screen.getByText('The discount is above your limit. A supervisor must approve it.'),
    ).toBeTruthy();
    await approve('Long-standing customer');
    await screen.findByRole('heading', { name: 'INV-000300', level: 1 });

    expect(bridge.callsTo('POST', '/api/v1/approvals')[0]!.body).toMatchObject({
      permission: 'sales.discount_over_limit',
      approverId: '8',
      pin: '4826',
      reason: 'Long-standing customer',
    });
    const issues = bridge.callsTo('POST', '/api/v1/sales/documents/300/issue');
    expect(issues).toHaveLength(2);
    expect(issues[0]!.body).toEqual({ rowVersion: 3 });
    expect(issues[1]!.body).toEqual({ rowVersion: 3, approvalId: '555' });
  });

  it('unpaid for a cash customer: the credit approval is sent as creditApprovalId', async () => {
    const bridge = bridgeFor(OFFICE, '/invoices/300')
      .on('GET', '/api/v1/sales/documents/300', ok(DRAFT))
      .on(
        'POST',
        '/api/v1/sales/documents/300/issue',
        failure(403, 'RULE_VIOLATION', { rule: 'CREDIT_LIMIT' }),
        ok(ISSUED_300),
      )
      .on(
        'POST',
        '/api/v1/approvals',
        ok({ approvalId: '556', expiresAt: '2026-10-12T09:00:00Z' }),
      );
    await signIn(bridge, 'Invoice draft');
    fireEvent.click(await screen.findByRole('button', { name: 'Issue invoice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue the invoice' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Issue' }));

    expect(await screen.findByRole('dialog', { name: 'Credit sale approval' })).toBeTruthy();
    await approve('Pays at month end');
    await screen.findByRole('heading', { name: 'INV-000300', level: 1 });
    expect(bridge.callsTo('POST', '/api/v1/approvals')[0]!.body).toMatchObject({
      permission: 'sales.credit_over_limit',
    });
    expect(bridge.callsTo('POST', '/api/v1/sales/documents/300/issue')[1]!.body).toEqual({
      rowVersion: 3,
      creditApprovalId: '556',
    });
  });
});

describe('Invoices (A4): an issued document', () => {
  const FINAL = detail({
    id: '310',
    docNumber: 'INV-000310',
    netFils: '3000000',
    vatFils: '150000',
    totalFils: '3150000',
    settledFils: '0',
    settlementStatus: 'open',
    settlements: [],
    lines: [
      line({
        id: '601',
        itemCode: 'SRV-POOL',
        descriptionEn: 'Pool construction',
        descriptionAr: 'إنشاء مسبح',
        quantityMilli: '1000',
        listPrice4dp: '1000000000',
        unitPrice4dp: '1000000000',
        amountBeforeDiscountFils: '10000000',
        netFils: '10000000',
        vatFils: '500000',
        grossFils: '10500000',
      }),
      line({
        id: '602',
        lineNo: 2,
        lineKind: 'advance_deduction',
        itemId: null,
        itemCode: null,
        descriptionEn: 'Less: payment INV-000201',
        descriptionAr: 'يُخصم: دفعة INV-000201',
        netFils: '-3000000',
        vatFils: '-150000',
        grossFils: '-3150000',
        advanceDocumentId: '201',
        advanceDocumentNumber: 'INV-000201',
      }),
      line({
        id: '603',
        lineNo: 3,
        lineKind: 'advance_deduction',
        itemId: null,
        itemCode: null,
        descriptionEn: 'Less: payment INV-000250',
        descriptionAr: 'يُخصم: دفعة INV-000250',
        netFils: '-4000000',
        vatFils: '-200000',
        grossFils: '-4200000',
        advanceDocumentId: '250',
        advanceDocumentNumber: 'INV-000250',
      }),
    ],
  });

  it('shows the deductions (decision 0013) and prints: the PDF, then the printed count', async () => {
    printed.files.length = 0;
    const file = { fileName: 'INV-000310.pdf', mime: 'application/pdf', dataBase64: 'JVBERi0=' };
    const bridge = bridgeFor(OFFICE, '/invoices/310')
      .on('GET', '/api/v1/sales/documents/310', ok(FINAL))
      .on('GET', '/api/v1/sales/documents/310/pdf', ok(file))
      .on('POST', '/api/v1/sales/documents/310/printed', ok({ printCount: 1 }));
    await signIn(bridge, 'INV-000310');

    expect(screen.getByText('Full tax invoice')).toBeTruthy();
    expect(screen.getByText('100123456700003')).toBeTruthy();
    const lines = screen.getByRole('table', { name: 'Lines' });
    expect(within(lines).getAllByText('Earlier payment deducted')).toHaveLength(2);
    expect(within(lines).getByText('INV-000201')).toBeTruthy();
    expect(within(lines).getByText('-31,500.00')).toBeTruthy();
    expect(within(lines).getByText('-42,000.00')).toBeTruthy();
    const totals = screen.getByText('Total before deductions').closest('dl')!;
    const value = (label: string) =>
      within(totals).getByText(label).closest('div')!.querySelector('dd')!.textContent;
    expect(value('Total before deductions')).toBe('105,000.00');
    expect(value('Less: earlier payments')).toBe('-73,500.00');
    expect(value('VAT due on this invoice')).toBe('1,500.00');
    expect(value('Total due')).toBe('31,500.00');
    expect(screen.getByText('Nothing paid or credited yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Receive payment' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    await screen.findByText('Sent to the print dialog.');
    expect(printed.files).toEqual([file]);
    expect(bridge.callsTo('GET', '/api/v1/sales/documents/310/pdf')).toHaveLength(1);
    const count = bridge.callsTo('POST', '/api/v1/sales/documents/310/printed');
    expect(count).toHaveLength(1);
    expect(count[0]!.body).toEqual({});
  });

  it('a reprint needs documents.reprint', async () => {
    const bridge = bridgeFor(OFFICE, '/invoices/310').on(
      'GET',
      '/api/v1/sales/documents/310',
      ok({ ...FINAL, printCount: 1 }),
    );
    await signIn(bridge, 'INV-000310');
    expect(screen.getByRole('button', { name: 'Reprint' }).hasAttribute('data-disabled')).toBe(
      true,
    );
    expect(screen.getByText('Reprinting needs the reprint permission.')).toBeTruthy();
  });

  it('a credit note returning one pump as defective, with the supervisor approval', async () => {
    const NOTE = detail({
      id: '400',
      docType: 'credit_note',
      docNumber: 'CN-000400',
      originalDocumentId: '101',
      originalDocumentNumber: 'INV-000101',
      reasonCodeId: '61',
      reasonText: 'Pump returned faulty',
      netFils: '12500',
      vatFils: '625',
      totalFils: '13125',
      settledFils: '13125',
      settlementStatus: 'settled',
      settlements: [],
      lines: [
        line({
          id: '701',
          quantityMilli: '1000',
          originalLineId: '501',
          returnStockStatus: 'defective',
          netFils: '12500',
          vatFils: '625',
          grossFils: '13125',
        }),
      ],
    });
    const bridge = bridgeFor(
      OFFICE.filter((p) => p !== 'credit_notes.issue'),
      '/invoices/101',
    )
      .on(
        'GET',
        '/api/v1/sales/documents/101',
        ok(detail({ lines: [line({ creditedMilli: '0' })] })),
      )
      .on(
        'POST',
        '/api/v1/sales/notes',
        failure(403, 'PERMISSION_DENIED', { permission: 'credit_notes.issue' }),
        ok(NOTE, 201),
      )
      .on('POST', '/api/v1/approvals', ok({ approvalId: '557', expiresAt: '2026-10-12T09:00:00Z' }))
      .on('GET', '/api/v1/sales/documents/400', ok(NOTE));
    await signIn(bridge, 'INV-000101');

    fireEvent.click(screen.getByRole('button', { name: 'Credit note' }));
    const dialog = await screen.findByRole('dialog', { name: 'New credit note' });
    await within(dialog).findByRole('option', { name: 'Goods returned' });
    expect(within(dialog).queryByRole('option', { name: 'Extra work' })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: '61' } });
    fireEvent.change(within(dialog).getByLabelText(/Explanation/), {
      target: { value: 'Pump returned faulty' },
    });
    // Two were sold: three is refused before anything is sent.
    fireEvent.change(within(dialog).getByLabelText('Quantity — Pool pump'), {
      target: { value: '3' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Issue credit note' }));
    expect(await within(dialog).findByText('At most 2.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/sales/notes')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText('Quantity — Pool pump'), {
      target: { value: '1' },
    });
    fireEvent.change(within(dialog).getByLabelText('Returned goods — Pool pump'), {
      target: { value: 'defective' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Issue credit note' }));
    expect(await screen.findByRole('dialog', { name: 'Credit note approval' })).toBeTruthy();
    await approve('Faulty motor confirmed');
    await screen.findByRole('heading', { name: 'CN-000400', level: 1 });

    const notes = bridge.callsTo('POST', '/api/v1/sales/notes');
    expect(notes).toHaveLength(2);
    const body = {
      kind: 'credit_note',
      originalDocumentId: '101',
      reasonCodeId: '61',
      reasonText: 'Pump returned faulty',
      lines: [{ originalLineId: '501', quantityMilli: '1000', returnStockStatus: 'defective' }],
    };
    expect(notes[0]!.body).toEqual(body);
    expect(notes[1]!.body).toEqual({ ...body, approvalId: '557' });
    expect(bridge.callsTo('POST', '/api/v1/approvals')[0]!.body).toMatchObject({
      permission: 'credit_notes.issue',
    });
    // The note shows its original and where the goods went.
    expect(screen.getByRole('link', { name: 'INV-000101' })).toBeTruthy();
    expect(screen.getByText(/Back as defective/)).toBeTruthy();
  });
});

describe('Invoices (A4) in Arabic (right to left)', () => {
  it('a refused line is shown under the line, translated', async () => {
    const bridge = bridgeFor(OFFICE, '/invoices/new').on(
      'POST',
      '/api/v1/sales/invoices',
      failure(400, 'VALIDATION_FAILED', {
        part: 'body',
        issues: [{ path: ['lines.0.itemId'], code: 'not_for_sale' }],
      }),
    );
    await signIn(bridge, 'فاتورة ضريبية جديدة', 'ar');
    expect(document.documentElement.dir).toBe('rtl');

    fireEvent.change(screen.getByRole('searchbox', { name: /ابحث عن عميل/ }), {
      target: { value: 'Lagoon' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Blue Lagoon Villas/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: /ابحث عن صنف/ }), {
      target: { value: 'مضخة' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /مضخة مسبح/ }));
    const lines = await screen.findByRole('table', { name: 'البنود' });
    // 1 × 125.00 + VAT 5% = 131.25.
    expect(within(lines).getByText('6.25')).toBeTruthy();
    expect(within(lines).getByText('131.25')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ المسودة' }));
    expect(
      await within(lines).findByText(
        'لا يمكن بيع هذا الصنف (موقوف أو غير معروض للبيع أو بلا سعر).',
      ),
    ).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/sales/invoices')[0]!.body).toEqual({
      customerId: '20',
      lines: [{ itemId: '10', quantityMilli: '1000' }],
    });
  });
});
