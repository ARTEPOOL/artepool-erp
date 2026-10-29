/**
 * M4-T12: the Receipts section against a scripted server: the list and its filters; receiving a
 * payment (oldest first with the advance preview, chosen invoices, advance only on a quotation,
 * a cheque with its date and bank) with the exact request bodies (whole fils as text); the
 * receipt with what it paid, printing and the reversal of a bounced cheque (a translated
 * refusal); the statement of account and the owner-only opening balance in Customers.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  BridgeRequest,
  CustomerBalance,
  CustomerDetail,
  CustomerListItem,
  DocumentItem,
  OpeningBalanceItem,
  PaymentDetail,
  PaymentItem,
  QuotationItem,
  ReasonCodeItem,
  SalesPaymentMethod,
  StatementResponse,
} from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { setLanguage } from '../../src/i18n';
import { dubaiDay } from '../../src/lib/format';
import {
  failure,
  FakeBridge,
  ok,
  sessionView,
  signInAnswer,
  userView,
} from '../support/fake-bridge';

// The app always starts on the dashboard; these tests start straight on the page under test.
const start = vi.hoisted(() => ({ path: '/' }));
vi.mock('../../src/app/router', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/app/router')>();
  return { ...original, createAppRouter: () => original.createAppRouter(start.path) };
});

// The print dialog itself is the browser's; the tests check what is sent to it.
const printed = vi.hoisted(() => ({ files: [] as unknown[] }));
vi.mock('../../src/features/sales/print', () => ({
  printPdf: (file: unknown) => {
    printed.files.push(file);
    return Promise.resolve();
  },
}));

const TODAY = dubaiDay();

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
    code: 'TRANSFER',
    nameAr: 'تحويل بنكي',
    nameEn: 'Bank transfer',
    kind: 'bank_transfer',
    requiresReference: true,
    givesChange: false,
  },
  {
    id: '3',
    code: 'CHEQUE',
    nameAr: 'شيك',
    nameEn: 'Cheque',
    kind: 'cheque',
    requiresReference: true,
    givesChange: false,
  },
];

const reason = (patch: Partial<ReasonCodeItem>): ReasonCodeItem => ({
  id: '91',
  category: 'payment_reversal',
  code: 'BOUNCED',
  nameAr: 'شيك مرتجع',
  nameEn: 'Bounced cheque',
  requiresNote: false,
  glAccountId: null,
  isActive: true,
  rowVersion: 1,
  ...patch,
});

const REASONS: ReasonCodeItem[] = [
  reason({}),
  reason({
    id: '92',
    code: 'ENTRY_ERROR',
    nameAr: 'خطأ في التسجيل',
    nameEn: 'Entry error',
    requiresNote: true,
  }),
  reason({ id: '70', category: 'stock_count', code: 'LOSS', nameAr: 'فقد', nameEn: 'Loss' }),
];

const HOTEL: CustomerDetail = {
  id: '12',
  code: 'C00012',
  customerType: 'company',
  name: 'Al Waha Hotel',
  nameAlt: 'فندق الواحة',
  phone: '+97137654321',
  isVatRegistered: true,
  trn: '100456789000003',
  creditMode: 'credit',
  isWalkIn: false,
  isActive: true,
  phoneAlt: null,
  email: null,
  addressLine: null,
  area: null,
  city: 'Al Ain',
  poBox: null,
  emirate: 'abu_dhabi',
  countryCode: 'AE',
  paymentTermsDays: 30,
  creditLimitFils: '1000000',
  preferredLanguage: null,
  notes: null,
  rowVersion: 3,
};

const HOTEL_ITEM: CustomerListItem = {
  id: HOTEL.id,
  code: HOTEL.code,
  customerType: HOTEL.customerType,
  name: HOTEL.name,
  nameAlt: HOTEL.nameAlt,
  phone: HOTEL.phone,
  isVatRegistered: HOTEL.isVatRegistered,
  trn: HOTEL.trn,
  creditMode: HOTEL.creditMode,
  isWalkIn: false,
  isActive: true,
};

const BALANCE: CustomerBalance = {
  balanceFils: '360000',
  creditMode: 'credit',
  creditLimitFils: '1000000',
  advancesFils: '31500',
};

const OPENING: OpeningBalanceItem = {
  id: '7',
  customerId: '12',
  balanceDate: '2026-01-01',
  direction: 'receivable',
  amountFils: '50000',
  settledFils: '0',
  reference: 'OB-1',
};

const doc = (patch: Partial<DocumentItem>): DocumentItem => ({
  id: '40',
  docType: 'invoice',
  invoiceFormat: 'full',
  status: 'issued',
  docNumber: 'INV-000010',
  channel: 'office',
  customerId: '12',
  customerName: 'Al Waha Hotel',
  issueDate: '2026-09-01',
  dueDate: null,
  settledFils: '5000',
  settlementStatus: 'partial',
  originalDocumentId: null,
  originalDocumentNumber: null,
  quotationId: null,
  printCount: 1,
  rowVersion: 2,
  discountTotalFils: '0',
  netFils: '100000',
  vatFils: '5000',
  totalFils: '105000',
  cancelledBy: null,
  creditedFils: '0',
  overdue: false,
  ...patch,
});

// Listed newest first, as the server lists them; the form puts the oldest first.
const OPEN_DOCS: DocumentItem[] = [
  doc({
    id: '41',
    docNumber: 'INV-000012',
    issueDate: '2026-09-20',
    settledFils: '0',
    settlementStatus: 'open',
    netFils: '200000',
    vatFils: '10000',
    totalFils: '210000',
  }),
  doc({}),
];

const payment = (patch: Partial<PaymentDetail>): PaymentDetail => ({
  id: '60',
  paymentKind: 'receipt',
  status: 'posted',
  docNumber: 'RCT-000060',
  customerId: '12',
  customerName: 'Al Waha Hotel',
  paymentMethodId: '3',
  methodKind: 'cheque',
  amountFils: '400000',
  paymentDate: '2026-10-12',
  reference: 'CHQ-104455',
  reversalOfId: null,
  chequeDate: '2026-10-20',
  chequeBank: 'Emirates NBD',
  notes: null,
  advanceReason: null,
  receivedByName: { displayNameAr: 'سارة علي', displayNameEn: 'Sara Ali' },
  allocations: [
    {
      documentId: null,
      openingBalanceId: '7',
      docNumber: null,
      docType: 'opening_balance',
      amountFils: '50000',
    },
    {
      documentId: '40',
      openingBalanceId: null,
      docNumber: 'INV-000010',
      docType: 'invoice',
      amountFils: '100000',
    },
    {
      documentId: '41',
      openingBalanceId: null,
      docNumber: 'INV-000012',
      docType: 'invoice',
      amountFils: '210000',
    },
    {
      documentId: '45',
      openingBalanceId: null,
      docNumber: 'INV-000013',
      docType: 'advance_invoice',
      amountFils: '40000',
    },
  ],
  advanceDocumentId: '45',
  journalEntryId: '900',
  ...patch,
});

const listItem = (p: PaymentDetail): PaymentItem => ({
  id: p.id,
  paymentKind: p.paymentKind,
  status: p.status,
  docNumber: p.docNumber,
  customerId: p.customerId,
  customerName: p.customerName,
  paymentMethodId: p.paymentMethodId,
  methodKind: p.methodKind,
  amountFils: p.amountFils,
  paymentDate: p.paymentDate,
  reference: p.reference,
  reversalOfId: p.reversalOfId,
});

const RECEIPT = payment({});
const CASH_RECEIPT = payment({
  id: '58',
  docNumber: 'RCT-000058',
  status: 'reversed',
  paymentMethodId: '1',
  methodKind: 'cash',
  amountFils: '12550',
  paymentDate: '2026-10-05',
  reference: null,
});
const REVERSAL = payment({
  id: '61',
  paymentKind: 'reversal',
  docNumber: 'RVS-000003',
  reversalOfId: '58',
  paymentMethodId: '1',
  methodKind: 'cash',
  amountFils: '12550',
  reference: null,
  chequeDate: null,
  chequeBank: null,
  advanceDocumentId: null,
  allocations: [],
});

const QUOTATION: QuotationItem = {
  id: '80',
  docNumber: 'Q-000005',
  revision: 1,
  status: 'accepted',
  customerId: '12',
  customerName: 'Al Waha Hotel',
  quotationDate: '2026-10-01',
  validUntil: '2026-10-16',
  subject: 'New pool',
  convertedDocumentId: null,
  rowVersion: 3,
  discountTotalFils: '0',
  netFils: '10000000',
  vatFils: '500000',
  totalFils: '10500000',
};

const ACCOUNTANT = [
  'invoices.view',
  'payments.receive',
  'payments.refund',
  'payments.reverse',
  'statements.view',
  'quotations.manage',
  'customers.view',
];
const OWNER = [...ACCOUNTANT, 'customers.opening'];
const CASHIER = ['invoices.view', 'payments.receive', 'customers.view'];

function bridgeFor(permissions: string[], path: string) {
  start.path = path;
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
    .on('GET', '/api/v1/sales/payment-methods', ok({ paymentMethods: METHODS }))
    .on('GET', '/api/v1/reason-codes', ok({ reasonCodes: REASONS }))
    .on(
      'GET',
      '/api/v1/settings/vat',
      ok({
        categories: [
          { id: '1', code: 'SR', nameAr: 'قياسي', nameEn: 'Standard', rateBp: 500, rowVersion: 1 },
        ],
        einvoiceMandatoryFrom: null,
      }),
    )
    .on(
      'GET',
      '/api/v1/customers',
      ok({ customers: [HOTEL_ITEM], total: 1, counts: { active: 1, vatRegistered: 1 } }),
    )
    .on('GET', '/api/v1/customers/12', ok(HOTEL))
    .on('GET', '/api/v1/customers/12/balance', ok(BALANCE))
    .on('GET', '/api/v1/customers/12/opening-balance', ok({ openingBalance: OPENING }))
    .on('GET', '/api/v1/sales/documents', ok({ documents: OPEN_DOCS, total: 2 }))
    .on('GET', '/api/v1/sales/quotations', (request: BridgeRequest) => {
      const status = new URLSearchParams(request.path.split('?')[1]).get('status');
      const quotations = status === 'accepted' ? [QUOTATION] : [];
      return ok({ quotations, total: quotations.length });
    })
    .on(
      'GET',
      '/api/v1/sales/payments',
      ok({ payments: [listItem(REVERSAL), listItem(RECEIPT), listItem(CASH_RECEIPT)], total: 3 }),
    )
    .on('GET', '/api/v1/sales/payments/60', ok(RECEIPT))
    .on('GET', '/api/v1/sales/payments/61', ok(REVERSAL));
}

async function signIn(bridge: FakeBridge, heading: string, language: 'ar' | 'en' = 'en') {
  if (language === 'en') await act(() => setLanguage('en'));
  render(<App bridge={bridge} />);
  const labels =
    language === 'en'
      ? { user: 'Username', password: 'Password', go: 'Sign in' }
      : { user: 'اسم المستخدم', password: 'كلمة المرور', go: 'دخول' };
  fireEvent.change(await screen.findByLabelText(labels.user), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText(labels.password), {
    target: { value: 'blue-pool-water' },
  });
  fireEvent.click(screen.getByRole('button', { name: labels.go }));
  await screen.findByRole('heading', { name: heading, level: 1 });
}

/** Chooses the hotel in the customer picker. */
async function chooseHotel(search = 'Search customers by name, phone or TRN') {
  fireEvent.change(screen.getByRole('searchbox', { name: search }), { target: { value: 'Waha' } });
  const results = await screen.findByRole('list');
  fireEvent.click(await within(results).findByRole('button', { name: /Al Waha Hotel/ }));
}

const debtsTable = () => screen.findByRole('table', { name: 'Unpaid invoices' });
const previewOf = () => screen.getByTestId('receive-preview');

function row(table: HTMLElement, text: string): HTMLElement {
  return within(table).getByText(text).closest('tr')!;
}

function receiveAnswer(p: PaymentDetail, advance: { id: string; docNumber: string } | null) {
  return ok(
    {
      payment: p,
      advanceInvoice: advance ? { ...doc({ docType: 'advance_invoice' }), ...advance } : null,
    },
    201,
  );
}

// ---------------------------------------------------------------------------------------------

describe('Receipts list', () => {
  it('lists receipts, refunds and reversals; filters by kind, method and search', async () => {
    const bridge = bridgeFor(ACCOUNTANT, '/receipts');
    await signIn(bridge, 'Receipts');
    const table = await screen.findByRole('table', { name: 'Receipts, refunds and reversals' });
    const cheque = row(table, 'RCT-000060');
    expect(within(cheque).getByText('Receipt')).toBeTruthy();
    expect(within(cheque).getByText('Cheque')).toBeTruthy();
    expect(within(cheque).getByText('4,000.00')).toBeTruthy();
    expect(within(cheque).getByText('CHQ-104455')).toBeTruthy();
    expect(within(cheque).getByText('12/10/2026')).toBeTruthy();
    expect(within(row(table, 'RCT-000058')).getByText('Reversed')).toBeTruthy();
    expect(within(row(table, 'RVS-000003')).getByText('Reversal')).toBeTruthy();
    expect(within(row(table, 'RCT-000058')).getByText('125.50')).toBeTruthy();

    // The kind, the method and the search all go to the server.
    fireEvent.click(screen.getByRole('button', { name: 'Reversal' }));
    await waitFor(() =>
      expect(bridge.calls.some((c) => c.path.includes('kind=reversal'))).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByLabelText('Payment method'), { target: { value: 'cheque' } });
    await waitFor(() =>
      expect(bridge.calls.some((c) => c.path.includes('methodKind=cheque'))).toBe(true),
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Number, reference or customer' }), {
      target: { value: 'CHQ-104455' },
    });
    await waitFor(() =>
      expect(bridge.calls.some((c) => c.path.includes('q=CHQ-104455'))).toBe(true),
    );

    fireEvent.click(within(table).getByText('RCT-000060'));
    await screen.findByRole('heading', { name: 'RCT-000060', level: 1 });
  });
});

describe('Receive payment', () => {
  it('automatic: previews oldest first and the advance with its VAT, and sends no allocations', async () => {
    const created = payment({ paymentMethodId: '1', methodKind: 'cash', reference: null });
    const bridge = bridgeFor(ACCOUNTANT, '/receipts')
      .on(
        'POST',
        '/api/v1/sales/payments',
        receiveAnswer(created, { id: '45', docNumber: 'INV-000013' }),
      )
      .on('GET', '/api/v1/sales/payments/60', ok(created));
    await signIn(bridge, 'Receipts');
    fireEvent.click(screen.getByRole('button', { name: 'Receive payment' }));
    await screen.findByRole('heading', { name: 'Receive payment', level: 1 });
    await chooseHotel();
    expect(await screen.findByText('Current balance: 3,600.00')).toBeTruthy();

    const table = await debtsTable();
    await within(table).findByText('INV-000012');
    // The opening balance first, then the invoices by date (not the server's newest-first order).
    const numbers = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.querySelector('td')?.textContent);
    expect(numbers).toEqual(['OB-1', 'INV-000010', 'INV-000012']);
    expect(within(row(table, 'INV-000010')).getByText('1,000.00')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Amount received/), { target: { value: '4000' } });
    // Total, due and paid now.
    expect(within(row(table, 'OB-1')).getAllByText('500.00')).toHaveLength(3);
    expect(within(row(table, 'INV-000012')).getAllByText('2,100.00')).toHaveLength(3);
    expect(within(row(table, 'INV-000010')).getAllByText('1,000.00')).toHaveLength(2);
    const preview = previewOf();
    expect(within(preview).getByText('4,000.00')).toBeTruthy();
    expect(within(preview).getByText('3,600.00')).toBeTruthy();
    expect(within(preview).getByText('400.00')).toBeTruthy();
    // 400.00 × 5 ÷ 105 = 19.0476… → 19.05 (VAT inside the advance, decision 0013).
    expect(within(preview).getByText('19.05')).toBeTruthy();
    expect(screen.getByText(/The advance gets its own payment tax invoice/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Receive 4,000.00 AED' }));
    await screen.findByRole('heading', { name: 'RCT-000060', level: 1 });
    const call = bridge.callsTo('POST', '/api/v1/sales/payments')[0]!;
    expect(call.body).toEqual({
      customerId: '12',
      paymentDate: TODAY,
      part: { paymentMethodId: '1', amountFils: '400000' },
    });
    expect(call.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await screen.findByText('Payment received: RCT-000060. Payment invoice issued: INV-000013.'),
    ).toBeTruthy();
    const link = screen.getAllByRole('link', { name: 'INV-000013' })[0]!;
    expect(link.getAttribute('href')).toBe('/invoices/45');
  });

  it('manual: sends the chosen amounts (opening balance and an invoice); refuses more than the payment', async () => {
    const created = payment({ paymentMethodId: '2', methodKind: 'bank_transfer' });
    const bridge = bridgeFor(ACCOUNTANT, '/receipts/new')
      .on(
        'POST',
        '/api/v1/sales/payments',
        receiveAnswer(created, { id: '45', docNumber: 'INV-000013' }),
      )
      .on('GET', '/api/v1/sales/payments/60', ok(created));
    await signIn(bridge, 'Receive payment');
    await chooseHotel();
    const table = await debtsTable();
    await within(table).findByText('INV-000012');
    fireEvent.change(screen.getByLabelText('Payment method'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/Amount received/), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose invoices' }));

    fireEvent.change(screen.getByLabelText('Amount for INV-000012'), { target: { value: '600' } });
    fireEvent.change(screen.getByLabelText('Amount for OB-1'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Receive 500.00 AED' }));
    expect(
      await screen.findByText('The amounts chosen add up to more than the payment.'),
    ).toBeTruthy();
    // A transfer needs its reference.
    expect(screen.getByText('Required.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/sales/payments')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Amount for INV-000012'), { target: { value: '300' } });
    fireEvent.change(screen.getByLabelText(/Reference/), { target: { value: 'TRX-778' } });
    const preview = previewOf();
    expect(within(preview).getByText('400.00')).toBeTruthy();
    expect(within(preview).getByText('100.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Receive 500.00 AED' }));
    await screen.findByRole('heading', { name: 'RCT-000060', level: 1 });
    expect(bridge.callsTo('POST', '/api/v1/sales/payments')[0]!.body).toEqual({
      customerId: '12',
      paymentDate: TODAY,
      part: { paymentMethodId: '2', amountFils: '50000', reference: 'TRX-778' },
      allocations: [
        { openingBalanceId: '7', amountFils: '10000' },
        { documentId: '41', amountFils: '30000' },
      ],
    });
  });

  it('opens with the customer chosen when the link names one (from an invoice or a customer)', async () => {
    const bridge = bridgeFor(ACCOUNTANT, '/receipts/new?customerId=12');
    await signIn(bridge, 'Receive payment');
    // No search needed: the hotel is already chosen and its open debts are listed.
    const table = await debtsTable();
    expect(await within(table).findByText('INV-000012')).toBeTruthy();
    expect(
      screen.queryByRole('searchbox', { name: 'Search customers by name, phone or TRN' }),
    ).toBeNull();
    expect(bridge.callsTo('GET', '/api/v1/customers/12').length).toBeGreaterThan(0);
  });

  it('advance only, on an accepted quotation: VAT inside the amount, asAdvance and the quotation', async () => {
    const created = payment({ amountFils: '3150000', allocations: [], advanceDocumentId: '46' });
    const bridge = bridgeFor(ACCOUNTANT, '/receipts/new')
      .on(
        'POST',
        '/api/v1/sales/payments',
        receiveAnswer(created, { id: '46', docNumber: 'INV-000014' }),
      )
      .on('GET', '/api/v1/sales/payments/60', ok(created));
    await signIn(bridge, 'Receive payment');
    await chooseHotel();
    fireEvent.click(screen.getByRole('button', { name: 'Advance only' }));
    fireEvent.change(screen.getByLabelText(/Amount received/), { target: { value: '31,500' } });
    const preview = previewOf();
    expect(within(preview).getAllByText('31,500.00')).toHaveLength(2);
    // 31,500 includes VAT 1,500 (the 0013 example).
    expect(within(preview).getByText('1,500.00')).toBeTruthy();
    const quotation = await screen.findByLabelText('Quotation the advance is for (optional)');
    await waitFor(() =>
      expect(within(quotation).getByRole('option', { name: /Q-000005/ })).toBeTruthy(),
    );
    fireEvent.change(quotation, { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Receive 31,500.00 AED' }));
    await screen.findByRole('heading', { name: 'RCT-000060', level: 1 });
    expect(bridge.callsTo('POST', '/api/v1/sales/payments')[0]!.body).toEqual({
      customerId: '12',
      paymentDate: TODAY,
      part: { paymentMethodId: '1', amountFils: '3150000' },
      asAdvance: true,
      quotationId: '80',
    });
    expect(
      await screen.findByText('Payment received: RCT-000060. Payment invoice issued: INV-000014.'),
    ).toBeTruthy();
  });

  it('a cheque needs its number, date and bank (decision 0048)', async () => {
    const bridge = bridgeFor(CASHIER, '/receipts/new').on(
      'POST',
      '/api/v1/sales/payments',
      receiveAnswer(RECEIPT, null),
    );
    await signIn(bridge, 'Receive payment');
    await chooseHotel();
    fireEvent.change(screen.getByLabelText('Payment method'), { target: { value: '3' } });
    expect(screen.getByText(/A cheque counts as paid on the day it is received/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Amount received/), { target: { value: '1050' } });
    fireEvent.click(screen.getByRole('button', { name: 'Receive 1,050.00 AED' }));
    expect(await screen.findAllByText('Required.')).toHaveLength(3);
    expect(bridge.callsTo('POST', '/api/v1/sales/payments')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(/Cheque number/), { target: { value: 'CHQ-104455' } });
    fireEvent.change(screen.getByLabelText('Cheque date'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText(/Bank/), { target: { value: 'Emirates NBD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Receive 1,050.00 AED' }));
    await screen.findByRole('heading', { name: 'RCT-000060', level: 1 });
    expect(bridge.callsTo('POST', '/api/v1/sales/payments')[0]!.body).toEqual({
      customerId: '12',
      paymentDate: TODAY,
      part: {
        paymentMethodId: '3',
        amountFils: '105000',
        reference: 'CHQ-104455',
        chequeDate: '2026-10-20',
        chequeBank: 'Emirates NBD',
      },
    });
  });

  it('shows the server refusal translated', async () => {
    const bridge = bridgeFor(CASHIER, '/receipts/new').on(
      'POST',
      '/api/v1/sales/payments',
      failure(422, 'RULE_VIOLATION', { rule: 'ALLOCATION_EXCEEDS' }),
    );
    await signIn(bridge, 'Receive payment');
    await chooseHotel();
    fireEvent.change(screen.getByLabelText(/Amount received/), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Receive 10.00 AED' }));
    expect(
      await screen.findByText(
        'The amount is more than what remains on the document or of the payment.',
      ),
    ).toBeTruthy();
  });
});

describe('A receipt', () => {
  it('shows what it paid, the payment invoice, and prints through the PDF route', async () => {
    printed.files.length = 0;
    const file = { fileName: 'RCT-000060.pdf', mime: 'application/pdf', dataBase64: 'JVBERi0=' };
    const bridge = bridgeFor(CASHIER, '/receipts/60').on(
      'GET',
      '/api/v1/sales/payments/60/pdf',
      ok(file),
    );
    await signIn(bridge, 'RCT-000060');
    expect(screen.getByText('Cheque date')).toBeTruthy();
    expect(screen.getByText('20/10/2026')).toBeTruthy();
    expect(screen.getByText('Emirates NBD')).toBeTruthy();
    expect(screen.getByText('Sara Ali')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'What it paid' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Opening balanceOpening balance500.00',
      'INV-000010Tax invoice1,000.00',
      'INV-000012Tax invoice2,100.00',
      'INV-000013Payment invoice400.00',
    ]);
    expect(within(rows[1]!).getByRole('link', { name: 'INV-000010' }).getAttribute('href')).toBe(
      '/invoices/40',
    );
    expect(screen.getByText('Payment invoice issued for the advance:')).toBeTruthy();
    // The cashier may not reverse.
    expect(screen.queryByRole('button', { name: 'Reverse (bounced cheque)' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(printed.files).toEqual([file]));
    expect(bridge.callsTo('GET', '/api/v1/sales/payments/60/pdf')).toHaveLength(1);
  });

  it('reverses a bounced cheque with a reason: the exact body, then the reversal (RVS-)', async () => {
    const bridge = bridgeFor(ACCOUNTANT, '/receipts/60').on(
      'POST',
      '/api/v1/sales/payments/60/reverse',
      ok(REVERSAL, 201),
    );
    await signIn(bridge, 'RCT-000060');
    fireEvent.click(screen.getByRole('button', { name: 'Reverse (bounced cheque)' }));
    const dialog = await screen.findByRole('dialog');
    const select = within(dialog).getByLabelText('Reason');
    // Only the reversal reasons are offered.
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Choose…', 'Bounced cheque', 'Entry error']),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reverse the payment' }));
    expect(await within(dialog).findByText('Choose a reason.')).toBeTruthy();
    // "Entry error" needs a note.
    fireEvent.change(select, { target: { value: '92' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reverse the payment' }));
    expect(await within(dialog).findByText('Write a note for this reason.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/sales/payments/60/reverse')).toHaveLength(0);

    fireEvent.change(select, { target: { value: '91' } });
    fireEvent.change(within(dialog).getByLabelText(/Note/), {
      target: { value: 'Returned by the bank' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reverse the payment' }));
    await screen.findByRole('heading', { name: 'RVS-000003', level: 1 });
    expect(bridge.callsTo('POST', '/api/v1/sales/payments/60/reverse')[0]!.body).toEqual({
      reasonCodeId: '91',
      notes: 'Returned by the bank',
    });
    expect(await screen.findByText('Payment reversed: RVS-000003.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the original' }).getAttribute('href')).toBe(
      '/receipts/58',
    );
  });

  it('a payment whose payment invoice was deducted cannot be reversed: the refusal, translated', async () => {
    const bridge = bridgeFor(ACCOUNTANT, '/receipts/60').on(
      'POST',
      '/api/v1/sales/payments/60/reverse',
      failure(422, 'RULE_VIOLATION', { rule: 'ADVANCE_DEDUCTION' }),
    );
    await signIn(bridge, 'RCT-000060');
    fireEvent.click(screen.getByRole('button', { name: 'Reverse (bounced cheque)' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Bounced cheque' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: '91' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reverse the payment' }));
    expect(
      await within(dialog).findByText(/a final invoice has already deducted the payment invoice/),
    ).toBeTruthy();
  });
});

describe('Customer account', () => {
  const statement: StatementResponse = {
    customerId: '12',
    from: `${TODAY.slice(0, 4)}-01-01`,
    to: TODAY,
    openingFils: '0',
    lines: [
      {
        date: '2026-01-01',
        kind: 'opening_balance',
        id: '7',
        docNumber: 'OB-1',
        debitFils: '50000',
        creditFils: '0',
        balanceFils: '50000',
      },
      {
        date: '2026-09-01',
        kind: 'invoice',
        id: '40',
        docNumber: 'INV-000010',
        debitFils: '105000',
        creditFils: '0',
        balanceFils: '155000',
      },
      {
        date: '2026-10-12',
        kind: 'receipt',
        id: '60',
        docNumber: 'RCT-000060',
        debitFils: '0',
        creditFils: '5000',
        balanceFils: '150000',
      },
    ],
    closingFils: '150000',
  };

  it('shows the balance and the statement of account, and prints it with the dates', async () => {
    printed.files.length = 0;
    const file = { fileName: 'statement-12.pdf', mime: 'application/pdf', dataBase64: 'JVBERi0=' };
    const bridge = bridgeFor(ACCOUNTANT, '/customers')
      .on('GET', '/api/v1/customers/12/statement', ok(statement))
      .on('GET', '/api/v1/customers/12/statement/pdf', ok(file));
    await signIn(bridge, 'Customers');
    const panel = (await screen.findByRole('heading', { name: 'Account', level: 2 })).closest(
      'aside',
    )!;
    expect(await within(panel).findByText('3,600.00')).toBeTruthy();
    expect(within(panel).getByText('Credit up to 10,000.00')).toBeTruthy();
    expect(within(panel).getByText('315.00')).toBeTruthy();
    // The opening balance is the owner's.
    expect(within(panel).queryByRole('button', { name: 'Opening balance' })).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: 'Statement of account' }));
    const dialog = await screen.findByRole('dialog');
    const table = await within(dialog).findByRole('table', { name: 'Statement of account' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      `01/01/${TODAY.slice(0, 4)}Balance brought forward0.00`,
      '01/01/2026Opening balance OB-1500.00500.00',
      '01/09/2026Tax invoice INV-0000101,050.001,550.00',
      '12/10/2026Receipt RCT-00006050.001,500.00',
      `${TODAY.slice(8, 10)}/${TODAY.slice(5, 7)}/${TODAY.slice(0, 4)}Closing balance1,500.00`,
    ]);
    const query = `from=${TODAY.slice(0, 4)}-01-01&to=${TODAY}`;
    expect(bridge.calls.some((c) => c.path === `/api/v1/customers/12/statement?${query}`)).toBe(
      true,
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(printed.files).toEqual([file]));
    expect(bridge.calls.some((c) => c.path === `/api/v1/customers/12/statement/pdf?${query}`)).toBe(
      true,
    );
  });

  it('the owner enters the opening balance once: exact fils', async () => {
    let saved: OpeningBalanceItem | null = null;
    const bridge = bridgeFor(OWNER, '/customers')
      .on('GET', '/api/v1/customers/12/opening-balance', () => ok({ openingBalance: saved }))
      .on('POST', '/api/v1/customers/opening-balances', () => {
        saved = { ...OPENING, amountFils: '125050', reference: 'Old ledger p.12' };
        return ok(saved, 201);
      });
    await signIn(bridge, 'Customers');
    fireEvent.click(await screen.findByRole('button', { name: 'Opening balance' }));
    let dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/It can be entered only once/);
    fireEvent.change(within(dialog).getByLabelText(/Amount/), { target: { value: '1250.5' } });
    fireEvent.change(within(dialog).getByLabelText('Reference'), {
      target: { value: 'Old ledger p.12' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save opening balance' }));
    expect(await screen.findByText('Opening balance saved.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/customers/opening-balances')[0]!.body).toEqual({
      customerId: '12',
      direction: 'receivable',
      amountFils: '125050',
      balanceDate: TODAY,
      reference: 'Old ledger p.12',
    });

    // Once entered, it is only shown.
    fireEvent.click(screen.getByRole('button', { name: 'Opening balance' }));
    dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('1,250.50')).toBeTruthy();
    expect(within(dialog).getByText(/already entered and cannot be changed/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Save opening balance' })).toBeNull();
  });
});

describe('Access', () => {
  it('without invoices.view the section shows no access and nothing else', async () => {
    const bridge = bridgeFor(['customers.view'], '/receipts');
    await signIn(bridge, 'Receipts');
    expect(screen.getByText('You do not have permission to see this page.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Receive payment' })).toBeNull();
    expect(bridge.callsTo('GET', '/api/v1/sales/payments')).toHaveLength(0);
  });

  it('receiving needs payments.receive', async () => {
    const bridge = bridgeFor(['invoices.view'], '/receipts/new');
    await signIn(bridge, 'Receipts');
    expect(screen.getByText('You do not have permission to see this page.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Receive/ })).toBeNull();
  });
});

describe('Receipts in Arabic (right to left)', () => {
  it('lists receipts and receives a payment, oldest first', async () => {
    const bridge = bridgeFor(ACCOUNTANT, '/receipts').on(
      'POST',
      '/api/v1/sales/payments',
      receiveAnswer(RECEIPT, null),
    );
    await signIn(bridge, 'إيصالات الاستلام', 'ar');
    expect(document.documentElement.dir).toBe('rtl');
    const table = await screen.findByRole('table', { name: 'إيصالات الاستلام والرد والعكس' });
    expect(within(row(table, 'RCT-000058')).getByText('معكوس')).toBeTruthy();
    expect(within(row(table, 'RCT-000060')).getByText('شيك')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'رد مبلغ' }));
    await waitFor(() =>
      expect(bridge.calls.some((c) => c.path.includes('kind=refund'))).toBe(true),
    );

    fireEvent.click(screen.getByRole('button', { name: 'استلام دفعة' }));
    await screen.findByRole('heading', { name: 'استلام دفعة', level: 1 });
    await chooseHotel('ابحث عن عميل بالاسم أو الهاتف أو الرقم الضريبي');
    const debts = await screen.findByRole('table', { name: 'الفواتير غير المدفوعة' });
    await within(debts).findByText('INV-000012');
    fireEvent.change(screen.getByLabelText(/المبلغ المستلم/), { target: { value: '١٥٠٠' } });
    expect(within(row(debts, 'OB-1')).getAllByText('500.00')).toHaveLength(3);
    expect(within(row(debts, 'INV-000010')).getAllByText('1,000.00')).toHaveLength(2);
    expect(within(row(debts, 'INV-000012')).queryAllByText('2,100.00')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'استلام 1,500.00 درهم' }));
    await screen.findByRole('heading', { name: 'RCT-000060', level: 1 });
    expect(bridge.callsTo('POST', '/api/v1/sales/payments')[0]!.body).toEqual({
      customerId: '12',
      paymentDate: TODAY,
      part: { paymentMethodId: '1', amountFils: '150000' },
    });
    expect(await screen.findByText('تم استلام الدفعة: RCT-000060.')).toBeTruthy();
  });
});
