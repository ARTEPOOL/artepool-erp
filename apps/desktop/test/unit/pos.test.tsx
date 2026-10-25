/**
 * M5-T5/T6: the POS against a scripted server. A scanned barcode goes straight to the cart; a cash
 * sale sends one request with the tendered amount (change worked out), the receipt prints (here:
 * the preview, outside the Windows app); selling beyond stock asks a supervisor and sends the same
 * sale again with the approval; a PC without a shift asks for the float; the blind count shows
 * the expected amount only after counting. Arabic (RTL) and English.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  BridgeRequest,
  BridgeResponse,
  CountResult,
  ItemListItem,
  PosSaleResponse,
  PosState,
  ReceiptData,
  ShiftSummary,
} from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { setLanguage } from '../../src/i18n';
import {
  failure,
  FakeBridge,
  ok,
  POS,
  sessionView,
  signInAnswer,
  userView,
} from '../support/fake-bridge';

const start = vi.hoisted(() => ({ path: '/' }));
vi.mock('../../src/app/router', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/app/router')>();
  return { ...original, createAppRouter: () => original.createAppRouter(start.path) };
});

// No canvas or printer in the test browser: the tests check what would be printed.
const printed = vi.hoisted(() => ({
  receipts: [] as { data: unknown; kick: boolean }[],
  kicks: 0,
}));
vi.mock('../../src/features/pos/receipt/printer', () => ({
  printReceipt: (data: unknown, opts: { kickDrawer: boolean }) => {
    printed.receipts.push({ data, kick: opts.kickDrawer });
    return Promise.resolve({
      outcome: { printed: false, reason: 'browser' },
      imageUrl: 'data:image/png;base64,AA==',
    });
  },
  kickDrawer: () => {
    printed.kicks += 1;
    return Promise.resolve({ printed: false, reason: 'browser' });
  },
  sendJob: () => Promise.resolve({ printed: false, reason: 'browser' }),
  canPrintSilently: () => false,
  listPrinters: () => Promise.resolve([]),
  savedPrinter: () => null,
  savePrinter: () => undefined,
}));

const SHIFT: ShiftSummary = {
  id: '30',
  shiftNumber: 'Z-000042',
  status: 'open',
  registerId: '4',
  registerCode: 'REG-COUNTER-01',
  cashierId: '5',
  cashierName: { displayNameAr: 'أحمد حسن', displayNameEn: 'Ahmed Hassan' },
  openedAt: '2026-10-13T05:00:00Z',
  closedAt: null,
  openingFloatFils: '50000',
};

const STATE: PosState = {
  isPosDevice: true,
  registerId: '4',
  shift: SHIFT,
  drawerBusyWith: null,
  walkInCustomerId: '1',
  paymentMethods: [
    {
      id: '1',
      code: 'CASH',
      nameAr: 'نقدًا',
      nameEn: 'Cash',
      kind: 'cash',
      opensDrawer: true,
      givesChange: true,
    },
    {
      id: '2',
      code: 'CARD',
      nameAr: 'بطاقة',
      nameEn: 'Card',
      kind: 'card',
      opensDrawer: false,
      givesChange: false,
    },
  ],
  denominations: [
    { id: '11', valueFils: '10000', kind: 'note' },
    { id: '12', valueFils: '100', kind: 'coin' },
    { id: '13', valueFils: '5', kind: 'coin' },
  ],
  receiptLanguage: 'both',
  dropDue: false,
  expectedCashFils: null,
};

const TABLETS: ItemListItem = {
  id: '7',
  code: 'TCCA90-05',
  itemType: 'stock',
  nameAr: 'كلور أقراص',
  nameEn: 'Chlorine tablets',
  categoryId: '2',
  unitId: '1',
  vatCategoryId: '1',
  price: { price4dp: '1260000', includesVat: true },
  primaryBarcode: '6281000000017',
  isSellable: true,
  isActive: true,
  stock: { onHandMilli: '3000', defectiveMilli: '0', reorderLevelMilli: null, toReorder: false },
};

const RECEIPT = { document: { id: '90', docNumber: 'POS-000125' } } as unknown as ReceiptData;
const SOLD = {
  receipt: RECEIPT,
  document: RECEIPT.document,
  payments: [],
  changeFils: '2400',
  opensDrawer: true,
  oversellAdjustmentNumber: null,
  dropDue: false,
  expectedCashFils: null,
} as unknown as PosSaleResponse;

const CASHIER = [
  'pos.sell',
  'shifts.open',
  'shifts.close',
  'cash.drop',
  'cash.paid_in',
  'reports.x',
  'items.view',
  'customers.view',
  'invoices.view',
];

/** The catalog: the tablets, or (`hidden`) only when their barcode is searched. */
const catalogAnswer =
  (hidden: boolean) =>
  (request: BridgeRequest): BridgeResponse => {
    const q = new URLSearchParams(request.path.split('?')[1]).get('q') ?? '';
    const found = !hidden || q === '6281000000017';
    return ok({
      items: found ? [TABLETS] : [],
      total: found ? 1 : 0,
      counts: { active: 1, stock: 1, service: 0, bundle: 0 },
      exactMatchId: hidden && found ? '7' : null,
    });
  };

function bridgeFor(path: string, state: PosState = STATE, options: { hidden?: boolean } = {}) {
  start.path = path;
  return new FakeBridge(POS)
    .on(
      'GET',
      '/api/v1/auth/pin-users',
      ok({
        pinAllowed: true,
        users: [
          { id: '5', displayNameAr: 'أحمد حسن', displayNameEn: 'Ahmed Hassan', blocked: false },
        ],
      }),
    )
    .on(
      'POST',
      '/api/v1/auth/pin-sign-in',
      ok(signInAnswer({ authMethod: 'pin' }, { id: '5', signInMethod: 'pin' })),
    )
    .on(
      'GET',
      '/api/v1/auth/me',
      ok({
        session: sessionView(),
        user: userView({ id: '5', displayNameAr: 'أحمد حسن', displayNameEn: 'Ahmed Hassan' }),
        device: POS,
        permissions: CASHIER,
      }),
    )
    .on('GET', '/api/v1/pos/state', ok(state))
    .on('GET', '/api/v1/pos/held-carts', ok([]))
    .on('GET', '/api/v1/items', catalogAnswer(options.hidden ?? false))
    .on('GET', '/api/v1/item-categories', ok({ categories: [] }))
    .on(
      'GET',
      '/api/v1/units',
      ok({
        units: [
          {
            id: '1',
            code: 'PCS',
            nameAr: 'قطعة',
            nameEn: 'Piece',
            decimals: 0,
            isActive: true,
            rowVersion: 1,
          },
        ],
      }),
    )
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
      ok({
        customers: [
          {
            id: '1',
            code: 'WALKIN',
            customerType: 'individual',
            name: 'Cash customer',
            nameAlt: null,
            phone: null,
            isVatRegistered: false,
            trn: null,
            creditMode: 'cash',
            isWalkIn: true,
            isActive: true,
          },
        ],
        total: 1,
        counts: { active: 1, vatRegistered: 0 },
      }),
    )
    .on(
      'GET',
      '/api/v1/approvals/approvers',
      ok({ approvers: [{ id: '8', displayNameAr: 'خالد سالم', displayNameEn: 'Khalid Salem' }] }),
    )
    .on('POST', '/api/v1/approvals', ok({ approvalId: '555', expiresAt: '2026-10-13T07:00:00Z' }));
}

async function signIn(bridge: FakeBridge, heading: RegExp | string, language: 'ar' | 'en' = 'en') {
  if (language === 'en') await act(() => setLanguage('en'));
  render(<App bridge={bridge} />);
  // A POS PC: the cashier picks their name and types the 4-digit PIN (decision 0021).
  fireEvent.click(
    await screen.findByRole('button', { name: language === 'en' ? /Ahmed Hassan/ : /أحمد حسن/ }),
  );
  for (const digit of ['4', '8', '2', '9'])
    fireEvent.click(screen.getByRole('button', { name: digit }));
  await screen.findByText(heading);
}

async function scanTablets() {
  const search = await screen.findByRole('textbox', { name: 'Search items' });
  fireEvent.change(search, { target: { value: '6281000000017' } });
  await screen.findByRole('button', { name: /Chlorine tablets/ });
  fireEvent.keyDown(search, { key: 'Enter' });
  const cart = screen.getByLabelText('Cart');
  await within(cart).findByText('Chlorine tablets');
}

describe('POS sale', () => {
  it('a scanned barcode goes to the cart; cash with change is one request; the receipt prints', async () => {
    printed.receipts.length = 0;
    const bridge = bridgeFor('/pos').on('POST', '/api/v1/pos/sales', ok(SOLD, 201));
    await signIn(bridge, 'Z-000042');
    await scanTablets();
    await scanTablets(); // the same item again: one line, quantity 2
    fireEvent.click(screen.getByRole('button', { name: /^Pay/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Payment' });
    fireEvent.change(within(dialog).getByLabelText('Received from the customer'), {
      target: { value: '276' },
    });
    expect(within(dialog).getByText('24.00')).toBeTruthy(); // 276.00 − 252.00
    fireEvent.click(within(dialog).getByRole('button', { name: /Confirm payment/ }));

    expect(await screen.findByTestId('pos-receipt-number')).toHaveProperty(
      'textContent',
      'POS-000125',
    );
    const [sale] = bridge.callsTo('POST', '/api/v1/pos/sales');
    expect(sale!.body).toMatchObject({
      lines: [{ itemId: '7', quantityMilli: '2000' }],
      payments: [{ paymentMethodId: '1', amountFils: '25200', tenderedFils: '27600' }],
    });
    expect(sale!.body).not.toHaveProperty('customerId'); // the cash customer
    expect(printed.receipts).toEqual([{ data: RECEIPT, kick: true }]);
    expect(screen.getByRole('img', { name: 'Receipt preview' })).toBeTruthy();
  });

  it('a scan with the cursor anywhere: found by its barcode and into the cart, no click', async () => {
    // The tablets are not among the items shown: they come only from the search for the barcode.
    await signIn(bridgeFor('/pos', STATE, { hidden: true }), 'Z-000042');
    await screen.findByRole('textbox', { name: 'Search items' });
    expect(screen.queryByRole('button', { name: /Chlorine tablets/ })).toBeNull();
    // The cursor on the page, not in the search box: the scanner types and presses Enter.
    (document.activeElement as HTMLElement | null)?.blur();
    for (const key of '6281000000017') fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    const cart = screen.getByLabelText('Cart');
    expect(await within(cart).findByText('Chlorine tablets')).toBeTruthy();
    // The search is empty again, ready for the next scan.
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Search items' }).value).toBe(
        '',
      ),
    );
  });

  it('selling beyond stock asks a supervisor, then sends the same sale with the approval', async () => {
    const bridge = bridgeFor('/pos').on(
      'POST',
      '/api/v1/pos/sales',
      failure(403, 'PERMISSION_DENIED', {
        rule: 'OVERSELL_APPROVAL',
        permission: 'pos.oversell',
        shortages: [
          {
            itemId: '7',
            code: 'TCCA90-05',
            nameAr: 'كلور أقراص',
            nameEn: 'Chlorine tablets',
            neededMilli: '5000',
            availableMilli: '3000',
          },
        ],
      }),
      ok({ ...SOLD, oversellAdjustmentNumber: 'ADJ-000009' }, 201),
    );
    await signIn(bridge, 'Z-000042');
    await scanTablets();
    fireEvent.click(screen.getByRole('button', { name: /^Pay/ }));
    const pay = await screen.findByRole('dialog', { name: 'Payment' });
    fireEvent.click(within(pay).getByRole('button', { name: /Confirm payment/ }));

    const approval = await screen.findByRole('dialog', { name: 'Selling beyond stock' });
    expect(within(approval).getByText(/needed 5, in stock 3/)).toBeTruthy();
    await within(approval).findByRole('option', { name: 'Khalid Salem' });
    fireEvent.change(within(approval).getByLabelText('Supervisor'), { target: { value: '8' } });
    fireEvent.change(within(approval).getByLabelText(/Code from the approver/), {
      target: { value: '482611' },
    });
    fireEvent.change(within(approval).getByLabelText(/^Reason/), {
      target: { value: 'Customer is waiting' },
    });
    fireEvent.click(within(approval).getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText(/ADJ-000009/)).toBeTruthy();
    const sales = bridge.callsTo('POST', '/api/v1/pos/sales');
    expect(sales).toHaveLength(2);
    expect(sales[1]!.body).toMatchObject({ oversellApprovalId: '555' });
    expect(bridge.callsTo('POST', '/api/v1/approvals')[0]!.body).toMatchObject({
      permission: 'pos.oversell',
    });
  });

  it('Arabic: the POS reads right to left with Arabic labels', async () => {
    const bridge = bridgeFor('/pos');
    await signIn(bridge, 'Z-000042', 'ar');
    expect(await screen.findByRole('textbox', { name: 'بحث الأصناف' })).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('button', { name: /الدفع/ })).toBeTruthy();
  });
});

describe('the shift', () => {
  it('without a shift, the cashier opens one with the float', async () => {
    printed.kicks = 0;
    const bridge = bridgeFor('/pos', { ...STATE, shift: null }).on(
      'POST',
      '/api/v1/shifts',
      ok(SHIFT, 201),
    );
    await signIn(bridge, 'Open the shift');
    fireEvent.change(screen.getByLabelText('Opening float'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open shift' }));
    await waitFor(() => expect(bridge.callsTo('POST', '/api/v1/shifts')).toHaveLength(1));
    expect(bridge.callsTo('POST', '/api/v1/shifts')[0]!.body).toEqual({
      openingFloatFils: '50000',
    });
    await waitFor(() => expect(printed.kicks).toBe(1));
  });

  it('blind count: the expected amount appears only after counting', async () => {
    const result: CountResult = {
      countId: '70',
      isRecount: false,
      countedFils: '39995',
      expectedFils: '40000',
      varianceFils: '-5',
      canRecount: true,
    };
    const bridge = bridgeFor('/pos/shift').on('POST', '/api/v1/shifts/current/count', ok(result));
    await signIn(bridge, 'My shift');
    fireEvent.click(await screen.findByRole('button', { name: 'Close the shift' }));
    const dialog = await screen.findByRole('dialog', { name: /blind count/ });
    expect(within(dialog).queryByText('Expected')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('How many of 100.00'), {
      target: { value: '3' },
    });
    fireEvent.change(within(dialog).getByLabelText('How many of 0.05'), {
      target: { value: '1999' },
    });
    expect(within(dialog).getByTestId('count-total').textContent).toBe('399.95');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save count' }));

    expect(await within(dialog).findByText('Expected')).toBeTruthy();
    expect(within(dialog).getByTestId('variance').textContent).toBe('-0.05');
    expect(bridge.callsTo('POST', '/api/v1/shifts/current/count')[0]!.body).toEqual({
      lines: [
        { denominationId: '11', quantity: 3 },
        { denominationId: '13', quantity: 1999 },
      ],
      otherAmountFils: '0',
    });
    expect(within(dialog).getByRole('button', { name: 'Recount (supervisor)' })).toBeTruthy();
  });
});
