/**
 * M3-T9: the stock parts of Items & stock (design 07) against a scripted server: the stock tiles
 * and columns (values only with stock.view_cost), the "To reorder" filter, the stock card with
 * its movements, the stock adjustment dialog (exact request, supervisor approval, refusals) and
 * the barcode labels dialog.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdjustmentDetail,
  BridgeRequest,
  CategoryItem,
  ItemDetail,
  ItemListItem,
  ItemStockFigures,
  ItemStockResponse,
  ItemsResponse,
  LabelSizeItem,
  ReasonCodeItem,
  StockSummary,
  UnitItem,
} from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import {
  FakeBridge,
  failure,
  ok,
  sessionView,
  signInAnswer,
  userView,
} from '../support/fake-bridge';

const STOREKEEPER = [
  'items.view',
  'stock.view',
  'stock.adjust',
  'stock.defective',
  'stock.count',
  'labels.print',
];
const OWNER = [
  ...STOREKEEPER,
  'items.manage',
  'stock.write_off',
  'stock.opening',
  'stock.view_cost',
];

const CATEGORIES: CategoryItem[] = [
  {
    id: '1',
    parentId: null,
    code: 'CHEM',
    nameAr: 'كيماويات',
    nameEn: 'Chemicals',
    sortOrder: 1,
    isActive: true,
    rowVersion: 1,
  },
];

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

const VAT = {
  categories: [
    { id: '1', code: 'SR', nameAr: 'قياسي', nameEn: 'Standard', rateBp: 500, rowVersion: 1 },
  ],
  einvoiceMandatoryFrom: null,
};

const CHLORINE: ItemDetail = {
  id: '10',
  code: 'CHEM-0012',
  itemType: 'stock',
  nameAr: 'كلور حبيبات 10 كجم',
  nameEn: 'Granular chlorine 10 kg',
  categoryId: '1',
  unitId: '1',
  vatCategoryId: '1',
  price: { price4dp: '125000', includesVat: false },
  primaryBarcode: '6291100000012',
  isSellable: true,
  isActive: true,
  descriptionAr: null,
  descriptionEn: null,
  defaultBusinessLineId: null,
  reorderLevelMilli: '5000',
  reorderQtyMilli: null,
  barcodes: [{ id: '1', barcode: '6291100000012', qtyPerScanMilli: '1000', isPrimary: true }],
  components: [],
  inUse: null,
  rowVersion: 3,
};

const listed = (item: ItemDetail, stock?: ItemStockFigures): ItemListItem => ({
  id: item.id,
  code: item.code,
  itemType: item.itemType,
  nameAr: item.nameAr,
  nameEn: item.nameEn,
  categoryId: item.categoryId,
  unitId: item.unitId,
  vatCategoryId: item.vatCategoryId,
  price: item.price,
  primaryBarcode: item.primaryBarcode,
  isSellable: item.isSellable,
  isActive: item.isActive,
  ...(stock ? { stock } : {}),
});

const reason = (patch: Partial<ReasonCodeItem>): ReasonCodeItem => ({
  id: '31',
  category: 'stock_decrease',
  code: 'DAMAGED',
  nameAr: 'تلف أثناء التخزين',
  nameEn: 'Damaged in storage',
  requiresNote: false,
  glAccountId: null,
  isActive: true,
  rowVersion: 1,
  ...patch,
});

const REASONS: ReasonCodeItem[] = [
  reason({}),
  reason({
    id: '32',
    category: 'stock_increase',
    code: 'FOUND',
    nameAr: 'عُثر عليه',
    nameEn: 'Found',
  }),
  reason({
    id: '33',
    category: 'stock_decrease',
    code: 'OTHER',
    nameAr: 'سبب آخر',
    nameEn: 'Other',
    requiresNote: true,
  }),
  reason({ id: '34', category: 'defective', code: 'BROKEN', nameAr: 'مكسور', nameEn: 'Broken' }),
];

const size = (patch: Partial<LabelSizeItem>): LabelSizeItem => ({
  id: '1',
  code: '38x25',
  nameAr: 'صغير',
  nameEn: 'Small',
  widthMm: 38,
  heightMm: 25,
  sortOrder: 1,
  isActive: true,
  rowVersion: 1,
  ...patch,
});

const SIZES = [
  size({
    id: '2',
    code: '50x30',
    nameAr: 'متوسط',
    nameEn: 'Medium',
    widthMm: 50,
    heightMm: 30,
    sortOrder: 2,
  }),
  size({}),
  size({
    id: '3',
    code: 'old',
    nameAr: 'قديم',
    nameEn: 'Old',
    widthMm: 20,
    heightMm: 10,
    isActive: false,
  }),
];

function itemStock(withCost: boolean): ItemStockResponse {
  return {
    balances: [
      {
        warehouseId: '1',
        stockStatus: 'available',
        quantityMilli: '10000',
        ...(withCost ? { value4dp: '625000', bookValueFils: '6250', avgUnitCost4dp: '62500' } : {}),
      },
      {
        warehouseId: '1',
        stockStatus: 'defective',
        quantityMilli: '1000',
        ...(withCost ? { value4dp: '62500', bookValueFils: '625', avgUnitCost4dp: '62500' } : {}),
      },
    ],
    movements: [
      {
        id: '2',
        movementType: 'adjustment_out',
        occurredAt: '2026-10-10T08:00:00Z',
        movementDate: '2026-10-10',
        warehouseId: '1',
        stockStatus: 'available',
        quantityMilli: '-2000',
        qtyAfterMilli: '10000',
        documentNumber: 'ADJ-000002',
        documentId: '2',
        documentKind: 'adjustment',
        reasonCodeId: '31',
      },
      {
        id: '1',
        movementType: 'opening',
        occurredAt: '2026-10-01T08:00:00Z',
        movementDate: '2026-10-01',
        warehouseId: '1',
        stockStatus: 'available',
        quantityMilli: '12000',
        qtyAfterMilli: '12000',
        documentNumber: 'ADJ-000001',
        documentId: '1',
        documentKind: 'adjustment',
        reasonCodeId: null,
      },
    ],
    totalMovements: 2,
  };
}

const adjustment = (patch: Partial<AdjustmentDetail> = {}): AdjustmentDetail => ({
  id: '3',
  docNumber: 'ADJ-000003',
  kind: 'decrease',
  status: 'posted',
  warehouseId: '1',
  date: '2026-10-11',
  reasonCodeId: '31',
  note: null,
  reviewStatus: 'not_required',
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
  postedAt: '2026-10-11T08:00:00Z',
  postedBy: '5',
  lineCount: 1,
  journalEntryId: '9',
  rowVersion: 1,
  lines: [],
  journalEntryNumber: 'JE-000009',
  ...patch,
});

function bridgeFor(permissions: string[]) {
  const withCost = permissions.includes('stock.view_cost');
  const figures: ItemStockFigures = {
    onHandMilli: '10000',
    defectiveMilli: '1000',
    reorderLevelMilli: '5000',
    toReorder: false,
    ...(withCost ? { avgUnitCost4dp: '62500' } : {}),
  };
  const summary: StockSummary = {
    ...(withCost ? { valueFils: '1234500' } : {}),
    toReorder: 2,
    defectiveItems: 1,
    pendingReviews: 0,
  };
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
    .on('GET', '/api/v1/item-categories', ok({ categories: CATEGORIES }))
    .on('GET', '/api/v1/units', ok({ units: UNITS }))
    .on('GET', '/api/v1/settings/vat', ok(VAT))
    .on('GET', '/api/v1/business-lines', ok({ businessLines: [] }))
    .on('GET', '/api/v1/reason-codes', ok({ reasonCodes: REASONS }))
    .on('GET', '/api/v1/label-sizes', ok({ labelSizes: SIZES }))
    .on('GET', '/api/v1/stock/summary', ok(summary))
    .on('GET', '/api/v1/items', (request: BridgeRequest) => {
      const toReorder = new URLSearchParams(request.path.split('?')[1]).get('toReorder');
      const answer: ItemsResponse = {
        items: [listed(CHLORINE, { ...figures, toReorder: toReorder === 'true' })],
        total: 1,
        counts: { active: 41, stock: 30, service: 8, bundle: 3 },
      };
      return ok(answer);
    })
    .on('GET', '/api/v1/items/10', ok(CHLORINE))
    .on('GET', '/api/v1/items/10/stock', ok(itemStock(withCost)));
}

async function openItems(bridge: FakeBridge) {
  render(<App bridge={bridge} />);
  await screen.findByRole('heading', { level: 1 });
  fireEvent.change(screen.getByLabelText('اسم المستخدم'), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'blue-pool-water' } });
  fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
  await screen.findByRole('heading', { name: 'أهلًا، محمد ياسر' });
  fireEvent.click(screen.getByRole('link', { name: 'الأصناف والمخزون' }));
  await screen.findByRole('heading', { name: 'الأصناف والمخزون', level: 1 });
}

async function row(name: string): Promise<HTMLElement> {
  const title = await screen.findByText(name, { selector: 'tbody b' });
  return title.closest('tr')!;
}

/** The stock section of the detail panel, once its movements have arrived. */
async function stockCard(): Promise<HTMLElement> {
  const section = await screen.findByRole('region', { name: 'المخزون' });
  await within(section.closest('div')!).findByText('ADJ-000002');
  return section.closest('div')!;
}

async function openAdjust(bridge: FakeBridge): Promise<HTMLElement> {
  await openItems(bridge);
  const card = await stockCard();
  fireEvent.click(within(card).getByRole('button', { name: 'تسوية' }));
  return screen.findByRole('dialog', { name: 'تسوية مخزون' });
}

afterEach(() => vi.restoreAllMocks());

describe('Items & stock: stock tiles and columns', () => {
  it('a storekeeper sees quantities but no value tile, no average cost and no values', async () => {
    await openItems(bridgeFor(STOREKEEPER));
    const chlorine = await row('كلور حبيبات 10 كجم');
    expect(screen.getByRole('columnheader', { name: 'المتاح' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'متوسط التكلفة' })).toBeNull();
    expect(within(chlorine).getByText('10')).toBeTruthy();
    expect(within(chlorine).getByText('قطعة')).toBeTruthy();
    expect(within(chlorine).queryByText('تحتاج طلب')).toBeNull();
    expect(await screen.findByText('تحتاج طلب', { selector: 'span' })).toBeTruthy();
    expect(screen.queryByText('قيمة المخزون')).toBeNull();
    expect(screen.getByText('أصناف فيها تالف')).toBeTruthy();
    const card = await stockCard();
    expect(within(card).queryByText('متوسط التكلفة')).toBeNull();
    expect(within(card).queryByText('قيمة المتاح')).toBeNull();
    // Header tools follow the permissions.
    expect(screen.getByRole('button', { name: 'تسوية مخزون' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'جرد المخزون' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'الرصيد الافتتاحي' })).toBeNull();
    // In the header and on the stock card.
    expect(screen.getAllByRole('button', { name: 'ملصقات باركود' })).toHaveLength(2);
  });

  it('with stock.view_cost: the stock value tile, the average cost column and card values', async () => {
    await openItems(bridgeFor(OWNER));
    const chlorine = await row('كلور حبيبات 10 كجم');
    expect(await screen.findByText('12,345.00')).toBeTruthy();
    expect(screen.getByText('قيمة المخزون')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'متوسط التكلفة' })).toBeTruthy();
    expect(within(chlorine).getByText('6.25')).toBeTruthy();
    const card = await stockCard();
    expect(within(card).getByText('قيمة المتاح').closest('div')!.textContent).toContain('62.50');
    expect(within(card).getByText('قيمة التالف').closest('div')!.textContent).toContain('6.25');
    expect(screen.getByRole('button', { name: 'الرصيد الافتتاحي' })).toBeTruthy();
  });

  it('"To reorder" (the filter or the tile) asks for toReorder=true and marks the rows', async () => {
    const bridge = bridgeFor(STOREKEEPER);
    await openItems(bridge);
    await row('كلور حبيبات 10 كجم');
    const filters = screen.getByRole('group', { name: 'التصنيف' });
    expect(
      within(filters)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['الكل', 'كيماويات', 'تحتاج طلب', 'موقوفة']);
    fireEvent.click(within(filters).getByRole('button', { name: 'تحتاج طلب' }));
    await waitFor(() =>
      expect(bridge.callsTo('GET', '/api/v1/items').at(-1)?.path).toContain('toReorder=true'),
    );
    const chlorine = await row('كلور حبيبات 10 كجم');
    expect(await within(chlorine).findByText('تحتاج طلب')).toBeTruthy();

    fireEvent.click(within(filters).getByRole('button', { name: 'الكل' }));
    await waitFor(() =>
      expect(bridge.callsTo('GET', '/api/v1/items').at(-1)?.path).not.toContain('toReorder'),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'اعرض الأصناف التي تحتاج طلب' }));
    await waitFor(() =>
      expect(bridge.callsTo('GET', '/api/v1/items').at(-1)?.path).toContain('toReorder=true'),
    );
  });
});

describe('Items & stock: the stock card', () => {
  it('lists the movements with their signed quantities, balances, documents and reasons', async () => {
    const bridge = bridgeFor(STOREKEEPER);
    await openItems(bridge);
    const card = await stockCard();
    const pair = within(card).getByTestId('stock-pair');
    expect(within(pair).getByText('10')).toBeTruthy();
    expect(within(pair).getByText('1')).toBeTruthy();
    const list = within(card).getByRole('list', { name: 'الحركات' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('تسوية بالنقص');
    expect(items[0]!.textContent).toContain('ADJ-000002');
    expect(items[0]!.textContent).toContain('تلف أثناء التخزين');
    expect(items[0]!.textContent).toContain('−2');
    expect(items[0]!.textContent).toContain('الرصيد بعدها 10');
    expect(items[1]!.textContent).toContain('رصيد افتتاحي');
    expect(items[1]!.textContent).toContain('ADJ-000001');
    expect(items[1]!.textContent).toContain('+12');
    expect(bridge.callsTo('GET', '/api/v1/items/10/stock')[0]!.path).toBe(
      '/api/v1/items/10/stock?page=1&pageSize=10',
    );
  });
});

describe('Items & stock: the stock adjustment dialog', () => {
  it('a storekeeper records a counted quantity of 7 with 10 on hand: a decrease of 3, no cost', async () => {
    const bridge = bridgeFor(STOREKEEPER).on(
      'POST',
      '/api/v1/stock/adjustments',
      ok(adjustment(), 201),
    );
    const dialog = await openAdjust(bridge);
    const ops = within(dialog).getByRole('group', { name: 'العملية' });
    // Only what the storekeeper may do (no write-off without stock.write_off).
    expect(
      within(ops)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['الكمية المعدودة', 'إضافة', 'خصم', 'نقل إلى التالف']);
    expect(within(dialog).getByText(/لا يُعدَّل الرصيد مباشرة/)).toBeTruthy();
    expect(within(dialog).queryByLabelText('تكلفة الوحدة (بدون ضريبة)')).toBeNull();

    fireEvent.change(within(dialog).getByLabelText('الكمية المعدودة فعليًا'), {
      target: { value: '7' },
    });
    const diff = within(dialog).getByTestId('adjust-diff');
    expect(diff.textContent).toContain('في النظام10');
    expect(diff.textContent).toContain('المعدود7');
    expect(diff.textContent).toContain('الفرق−3');
    // Decrease reasons only.
    const select = within(dialog).getByLabelText<HTMLSelectElement>('السبب');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'اختر…',
      'تلف أثناء التخزين',
      'سبب آخر',
    ]);
    fireEvent.change(select, { target: { value: '31' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل التسوية' }));

    expect(await screen.findByText('سُجِّلت التسوية ADJ-000003.')).toBeTruthy();
    const call = bridge.callsTo('POST', '/api/v1/stock/adjustments')[0]!;
    expect(call.body).toEqual({
      kind: 'decrease',
      reasonCodeId: '31',
      lines: [{ itemId: '10', quantityMilli: '3000' }],
    });
    expect(call.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('checks before sending: a reason that needs a note, and no difference', async () => {
    const bridge = bridgeFor(STOREKEEPER);
    const dialog = await openAdjust(bridge);
    fireEvent.change(within(dialog).getByLabelText('الكمية المعدودة فعليًا'), {
      target: { value: '10' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل التسوية' }));
    expect(
      await within(dialog).findByText('الكمية المعدودة تساوي ما في النظام: لا توجد تسوية.'),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('الكمية المعدودة فعليًا'), {
      target: { value: '8' },
    });
    fireEvent.change(within(dialog).getByLabelText('السبب'), { target: { value: '33' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل التسوية' }));
    expect(await within(dialog).findByText('هذا السبب يحتاج ملاحظة.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/stock/adjustments')).toHaveLength(0);
  });

  it('above the limit: the supervisor approves, then the same adjustment is sent with the approval', async () => {
    const bridge = bridgeFor(OWNER)
      .on(
        'POST',
        '/api/v1/stock/adjustments',
        failure(403, 'PERMISSION_DENIED', { rule: 'APPROVAL_REQUIRED' }),
        ok(adjustment({ kind: 'increase', docNumber: 'ADJ-000004' }), 201),
      )
      .on(
        'GET',
        '/api/v1/approvals/approvers',
        ok({ approvers: [{ id: '7', displayNameAr: 'سالم المشرف', displayNameEn: 'Salem' }] }),
      )
      .on('POST', '/api/v1/approvals', ok({ approvalId: '77', expiresAt: '2026-10-11T09:00:00Z' }));
    const dialog = await openAdjust(bridge);
    fireEvent.click(within(dialog).getByRole('button', { name: 'إضافة' }));
    fireEvent.change(within(dialog).getByLabelText('الكمية المضافة'), { target: { value: '40' } });
    fireEvent.change(within(dialog).getByLabelText('السبب'), { target: { value: '32' } });
    // With stock.view_cost the unit cost may be typed (4 decimals).
    fireEvent.change(within(dialog).getByLabelText('تكلفة الوحدة (بدون ضريبة)'), {
      target: { value: '62.5' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل التسوية' }));

    const approval = await screen.findByRole('dialog', { name: 'موافقة المشرف' });
    expect(within(approval).getByText(/أكبر من الحد المسموح/)).toBeTruthy();
    const approver = within(approval).getByLabelText('المشرف');
    await within(approver).findByRole('option', { name: 'سالم المشرف' });
    fireEvent.change(approver, { target: { value: '7' } });
    fireEvent.change(within(approval).getByLabelText('الرمز السري للمشرف'), {
      target: { value: '4826' },
    });
    fireEvent.change(within(approval).getByLabelText('السبب'), {
      target: { value: 'شحنة وصلت بدون فاتورة' },
    });
    fireEvent.click(within(approval).getByRole('button', { name: 'موافقة' }));

    expect(await screen.findByText('سُجِّلت التسوية ADJ-000004.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/approvals')[0]!.body).toMatchObject({
      permission: 'stock.adjust_over_threshold',
      approverId: '7',
      pin: '4826',
    });
    const [first, second] = bridge.callsTo('POST', '/api/v1/stock/adjustments');
    const sent = {
      kind: 'increase',
      reasonCodeId: '32',
      lines: [{ itemId: '10', quantityMilli: '40000', unitCost4dp: '625000' }],
    };
    expect(first!.body).toEqual(sent);
    expect(second!.body).toEqual({ ...sent, approvalId: '77' });
  });

  it('not enough stock: the translated refusal is shown in the dialog', async () => {
    const bridge = bridgeFor(STOREKEEPER).on(
      'POST',
      '/api/v1/stock/adjustments',
      failure(422, 'RULE_VIOLATION', { rule: 'STOCK_INSUFFICIENT' }),
    );
    const dialog = await openAdjust(bridge);
    fireEvent.click(within(dialog).getByRole('button', { name: 'نقل إلى التالف' }));
    fireEvent.change(within(dialog).getByLabelText('الكمية المنقولة إلى التالف'), {
      target: { value: '20' },
    });
    fireEvent.change(within(dialog).getByLabelText('السبب'), { target: { value: '34' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل التسوية' }));
    expect(await within(dialog).findByText('الكمية غير متوفرة في المخزون.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/stock/adjustments')[0]!.body).toEqual({
      kind: 'status_change',
      reasonCodeId: '34',
      lines: [{ itemId: '10', quantityMilli: '20000' }],
    });
  });

  it('refuses decimals the unit does not allow', async () => {
    const bridge = bridgeFor(STOREKEEPER);
    const dialog = await openAdjust(bridge);
    fireEvent.click(within(dialog).getByRole('button', { name: 'خصم' }));
    fireEvent.change(within(dialog).getByLabelText('الكمية المخصومة'), {
      target: { value: '1.5' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل التسوية' }));
    expect(
      await within(dialog).findByText('الكمية فيها أرقام عشرية أكثر مما تسمح به وحدتها.'),
    ).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/stock/adjustments')).toHaveLength(0);
  });
});

describe('Items & stock: barcode labels', () => {
  it('previews one label at the chosen size and prints the requested number', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    await openItems(bridgeFor(STOREKEEPER));
    const card = await stockCard();
    fireEvent.click(within(card).getByRole('button', { name: 'ملصقات باركود' }));
    const dialog = await screen.findByRole('dialog', { name: 'ملصقات باركود' });
    const sizeSelect = within(dialog).getByLabelText<HTMLSelectElement>('المقاس (مم)');
    // Active sizes only, in their order.
    await waitFor(() =>
      expect([...sizeSelect.options].map((o) => o.textContent)).toEqual([
        'صغير (38 × 25)',
        'متوسط (50 × 30)',
      ]),
    );
    const preview = within(dialog).getByTestId('label-preview');
    const label = preview.firstElementChild as HTMLElement;
    expect(label.style.getPropertyValue('--label-w')).toBe('38mm');
    expect(label.style.getPropertyValue('--label-h')).toBe('25mm');
    expect(within(preview).getByText('كلور حبيبات 10 كجم')).toBeTruthy();
    expect(within(preview).getByText('6291100000012')).toBeTruthy();
    // 12.50 excluding VAT → 13.13 with 5% VAT.
    expect(within(preview).getByText('13.13 درهم')).toBeTruthy();
    const bars = within(preview).getByRole('img', { name: 'باركود 6291100000012' });
    expect(bars.getAttribute('data-modules')).toBe(String(11 * 15 + 13));

    fireEvent.change(sizeSelect, { target: { value: '2' } });
    expect(label.style.getPropertyValue('--label-w')).toBe('50mm');
    expect(label.style.getPropertyValue('--label-h')).toBe('30mm');
    fireEvent.click(within(dialog).getByRole('switch', { name: 'طباعة السعر شامل الضريبة' }));
    expect(within(preview).queryByText('13.13 درهم')).toBeNull();

    fireEvent.change(within(dialog).getByLabelText('عدد الملصقات'), { target: { value: '0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'طباعة' }));
    expect(await within(dialog).findByText('اكتب عددًا من 1 إلى 500.')).toBeTruthy();
    expect(print).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('عدد الملصقات'), { target: { value: '3' } });
    let printed = 0;
    print.mockImplementation(() => {
      printed = screen.getByTestId('label-print').children.length;
      expect(document.head.textContent).toContain('@page { size: 50mm 30mm; margin: 0; }');
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'طباعة' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(printed).toBe(3);
    await waitFor(() => expect(screen.queryByTestId('label-print')).toBeNull());
    expect(document.head.textContent).not.toContain('@page');
  });
});
