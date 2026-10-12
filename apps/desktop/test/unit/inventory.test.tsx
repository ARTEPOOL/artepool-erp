/**
 * M3-T9: the stock pages against a scripted server: opening stock (exact amounts: quantities in
 * thousandths, costs in 4 decimals; owner only), blind counts (no system quantity, exact save),
 * the count review (a reason for every difference, the supervisor's approval above the limit)
 * and the oversell review (a note is required).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  AdjustmentDetail,
  AdjustmentItem,
  BridgeRequest,
  CountDetail,
  CountLine,
  ItemListItem,
  ReasonCodeItem,
  UnitItem,
} from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { dubaiDay } from '../../src/lib/format';
import {
  FakeBridge,
  failure,
  ok,
  sessionView,
  signInAnswer,
  userView,
} from '../support/fake-bridge';

// The app always starts on the dashboard; these tests start straight on a stock page.
const start = vi.hoisted(() => ({ path: '/' }));
vi.mock('../../src/app/router', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/app/router')>();
  return { ...original, createAppRouter: () => original.createAppRouter(start.path) };
});

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
  {
    id: '2',
    code: 'KG',
    nameAr: 'كيلوغرام',
    nameEn: 'Kilogram',
    decimals: 3,
    einvoiceCode: null,
    isActive: true,
    rowVersion: 1,
  },
];

const reason = (patch: Partial<ReasonCodeItem>): ReasonCodeItem => ({
  id: '90',
  category: 'other',
  code: 'OPENING',
  nameAr: 'رصيد افتتاحي',
  nameEn: 'Opening stock',
  requiresNote: false,
  glAccountId: null,
  isActive: true,
  rowVersion: 1,
  ...patch,
});

const REASONS: ReasonCodeItem[] = [
  reason({}),
  reason({ id: '71', category: 'stock_count', code: 'MISCOUNT', nameAr: 'خطأ عدّ سابق' }),
  reason({ id: '72', category: 'stock_count', code: 'LOSS', nameAr: 'فقد أو تلف' }),
];

const item = (patch: Partial<ItemListItem>): ItemListItem => ({
  id: '10',
  code: 'CHEM-0012',
  itemType: 'stock',
  nameAr: 'كلور حبيبات',
  nameEn: 'Granular chlorine',
  categoryId: '1',
  unitId: '1',
  vatCategoryId: '1',
  price: null,
  primaryBarcode: null,
  isSellable: true,
  isActive: true,
  ...patch,
});

const CHLORINE = item({});
const SALT = item({ id: '11', code: 'CHEM-0020', nameAr: 'ملح المسابح', unitId: '2' });

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
    .on('GET', '/api/v1/units', ok({ units: UNITS }))
    .on('GET', '/api/v1/item-categories', ok({ categories: [] }))
    .on('GET', '/api/v1/reason-codes', ok({ reasonCodes: REASONS }))
    .on('GET', '/api/v1/items', (request: BridgeRequest) => {
      const q = new URLSearchParams(request.path.split('?')[1]).get('q') ?? '';
      const items = [CHLORINE, SALT].filter((i) => i.nameAr.includes(q));
      return ok({
        items,
        total: items.length,
        counts: { active: 2, stock: 2, service: 0, bundle: 0 },
      });
    })
    .on('GET', '/api/v1/stock/adjustments', ok({ adjustments: [], total: 0 }));
}

async function signIn(bridge: FakeBridge, heading: string) {
  render(<App bridge={bridge} />);
  await screen.findByRole('heading', { level: 1 });
  fireEvent.change(screen.getByLabelText('اسم المستخدم'), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'blue-pool-water' } });
  fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
  await screen.findByRole('heading', { name: heading, level: 1 });
}

/** Searches the item picker and adds the item called `name`. */
async function addItem(name: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: /ابحث عن صنف مخزني/ }), {
    target: { value: name },
  });
  const results = await screen.findByRole('list', { name: 'نتائج البحث' });
  fireEvent.click(await within(results).findByRole('button', { name: new RegExp(name) }));
}

// ---------------------------------------------------------------------------------------------

const OWNER = [
  'items.view',
  'items.cost',
  'stock.view',
  'stock.view_cost',
  'stock.opening',
  'data.import',
];

const postedOpening: AdjustmentDetail = {
  id: '30',
  docNumber: 'ADJ-000001',
  kind: 'opening',
  status: 'posted',
  warehouseId: '1',
  date: '2026-10-12',
  reasonCodeId: '90',
  note: null,
  reviewStatus: 'not_required',
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
  postedAt: '2026-10-12T06:00:00.000Z',
  postedBy: '5',
  lineCount: 2,
  totalValueFils: '1235',
  journalEntryId: '700',
  rowVersion: 1,
  journalEntryNumber: 'JE-000700',
  lines: [
    {
      lineNo: 1,
      itemId: '10',
      itemCode: 'CHEM-0012',
      nameAr: 'كلور حبيبات',
      nameEn: 'Granular chlorine',
      unitId: '1',
      stockStatus: 'available',
      targetStatus: null,
      quantityMilli: '10000',
      note: null,
      unitCost4dp: '12345',
      valueFils: '1235',
    },
  ],
};

describe('Opening stock', () => {
  it('the owner posts opening stock: exact thousandths and 4-decimal costs, OPENING reason', async () => {
    const bridge = bridgeFor(OWNER, '/stock/opening')
      .on('GET', '/api/v1/items/10', ok({ ...CHLORINE, purchaseCost4dp: null }))
      .on('GET', '/api/v1/items/11', ok({ ...SALT, purchaseCost4dp: '20000' }))
      .on('POST', '/api/v1/stock/adjustments', ok(postedOpening, 201));
    await signIn(bridge, 'الرصيد الافتتاحي');
    expect(screen.getByText(/يُدخل الرصيد الافتتاحي مرة واحدة/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'استيراد من Excel' })).toBeTruthy();

    await addItem('كلور حبيبات');
    await addItem('ملح المسابح');
    fireEvent.change(screen.getByLabelText('كمية كلور حبيبات'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('تكلفة وحدة كلور حبيبات'), {
      target: { value: '1.2345' },
    });
    fireEvent.change(screen.getByLabelText('كمية ملح المسابح'), { target: { value: '2.5' } });
    // The salt has a purchase price: an empty cost will use it (shown as a hint).
    expect(await screen.findByText('2.00')).toBeTruthy();
    // 10 × 1.2345 = 12.345 → 12.35; 2.5 × 2.00 = 5.00 → 17.35.
    expect(within(screen.getByTestId('opening-total')).getByText('17.35')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'ترحيل الرصيد الافتتاحي' }));
    await screen.findByRole('status');
    const call = bridge.callsTo('POST', '/api/v1/stock/adjustments')[0]!;
    expect(call.body).toEqual({
      kind: 'opening',
      reasonCodeId: '90',
      date: dubaiDay(),
      lines: [
        { itemId: '10', quantityMilli: '10000', unitCost4dp: '12345' },
        { itemId: '11', quantityMilli: '2500' },
      ],
    });
    expect(call.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // The posted document: its number and its journal entry.
    expect((await screen.findAllByText('ADJ-000001')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('JE-000700').length).toBeGreaterThan(0);
  });

  it('refuses a fraction for a unit counted in pieces, before sending anything', async () => {
    const bridge = bridgeFor(OWNER, '/stock/opening');
    await signIn(bridge, 'الرصيد الافتتاحي');
    await addItem('كلور حبيبات');
    fireEvent.change(screen.getByLabelText('كمية كلور حبيبات'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'ترحيل الرصيد الافتتاحي' }));
    expect(await screen.findByText(/هذه الوحدة تقبل الأعداد الصحيحة فقط/)).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/stock/adjustments')).toHaveLength(0);
  });

  it('someone without stock.opening sees the note and the posted list, but no post button', async () => {
    const bridge = bridgeFor(['items.view', 'stock.view'], '/stock/opening').on(
      'GET',
      '/api/v1/stock/adjustments',
      ok({ adjustments: [postedOpening], total: 1 }),
    );
    await signIn(bridge, 'الرصيد الافتتاحي');
    expect(
      screen.getByText('المالك وحده يرحّل الرصيد الافتتاحي. يمكنك عرض المستندات المرحّلة فقط.'),
    ).toBeTruthy();
    expect(await screen.findByText('ADJ-000001')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ترحيل الرصيد الافتتاحي' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'استيراد من Excel' })).toBeNull();
    expect(screen.queryByRole('searchbox', { name: /ابحث عن صنف مخزني/ })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

const line = (patch: Partial<CountLine>): CountLine => ({
  id: '401',
  itemId: '10',
  itemCode: 'CHEM-0012',
  nameAr: 'كلور حبيبات',
  nameEn: 'Granular chlorine',
  unitId: '1',
  stockStatus: 'available',
  countedMilli: null,
  countedBy: null,
  countedAt: null,
  reasonCodeId: null,
  note: null,
  ...patch,
});

const count = (patch: Partial<CountDetail>): CountDetail => ({
  id: '40',
  docNumber: null,
  status: 'counting',
  scope: 'full',
  categoryId: null,
  warehouseId: '1',
  snapshotAt: '2026-10-12T05:00:00.000Z',
  countDate: null,
  note: null,
  lineCount: 2,
  countedLines: 0,
  postedAt: null,
  createdAt: '2026-10-12T05:00:00.000Z',
  rowVersion: 5,
  review: false,
  lines: [
    line({}),
    line({ id: '402', itemId: '11', itemCode: 'CHEM-0020', nameAr: 'ملح المسابح', unitId: '2' }),
  ],
  ...patch,
});

describe('Stock counts: blind counting', () => {
  it('the counter never sees the system quantity; Enter moves on; Save sends exact thousandths', async () => {
    const blind = count({});
    const bridge = bridgeFor(['stock.view', 'stock.count'], '/stock/counts/40')
      .on('GET', '/api/v1/stock/counts/40', ok(blind))
      .on('PUT', '/api/v1/stock/counts/40/lines', ok(count({ countedLines: 2 })));
    await signIn(bridge, 'جرد');
    expect(await screen.findByText(/لا تظهر كمية النظام أثناء العدّ/)).toBeTruthy();
    expect(screen.queryByText('كمية النظام')).toBeNull();
    expect(screen.queryByText('الفرق')).toBeNull();
    expect(screen.queryByRole('button', { name: 'ترحيل الجرد' })).toBeNull();

    const first = screen.getByLabelText('الكمية المعدودة من كلور حبيبات');
    const second = screen.getByLabelText('الكمية المعدودة من ملح المسابح');
    fireEvent.change(first, { target: { value: '٩' } });
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(document.activeElement).toBe(second);
    fireEvent.change(second, { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText('حُفظت الكميات.')).toBeTruthy();
    const call = bridge.callsTo('PUT', '/api/v1/stock/counts/40/lines')[0]!;
    expect(call.body).toEqual({
      lines: [
        { lineId: '401', countedMilli: '9000' },
        { lineId: '402', countedMilli: '2500' },
      ],
    });
  });

  it('the counts list goes to a count, and a new count is started with its scope', async () => {
    const bridge = bridgeFor(['stock.view', 'stock.count'], '/stock/counts')
      .on('GET', '/api/v1/stock/counts', ok({ counts: [], total: 0 }))
      .on('POST', '/api/v1/stock/counts', ok(count({}), 201))
      .on('GET', '/api/v1/stock/counts/40', ok(count({})));
    await signIn(bridge, 'الجرد');
    expect(await screen.findByText('لا توجد عمليات جرد بعد. ابدأ جردًا جديدًا.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'جرد جديد' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'أصناف مختارة' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'بدء الجرد' }));
    expect(await within(dialog).findByText('أضف صنفًا واحدًا على الأقل.')).toBeTruthy();
    await addItem('ملح المسابح');
    fireEvent.click(within(dialog).getByRole('button', { name: 'بدء الجرد' }));
    await screen.findByRole('heading', { name: 'جرد', level: 1 });
    expect(bridge.callsTo('POST', '/api/v1/stock/counts')[0]!.body).toEqual({
      scope: 'selected',
      itemIds: ['11'],
    });
  });
});

// ---------------------------------------------------------------------------------------------

const REVIEWER = ['stock.view', 'stock.count', 'stock.count_post', 'stock.view_cost'];

const reviewed = count({
  review: true,
  countedLines: 2,
  lines: [
    line({
      countedMilli: '9000',
      systemMilli: '10000',
      movedSinceMilli: '0',
      varianceMilli: '-1000',
      varianceFils: '-12500',
    }),
    line({
      id: '402',
      itemId: '11',
      itemCode: 'CHEM-0020',
      nameAr: 'ملح المسابح',
      unitId: '2',
      countedMilli: '2500',
      systemMilli: '3000',
      movedSinceMilli: '-500',
      varianceMilli: '0',
      varianceFils: '0',
    }),
  ],
});
const postedCount = count({ ...reviewed, status: 'posted', docNumber: 'CNT-000001' });

async function chooseReason() {
  await screen.findAllByRole('option', { name: 'فقد أو تلف' });
  fireEvent.change(screen.getByLabelText('سبب فرق كلور حبيبات'), { target: { value: '72' } });
  fireEvent.change(screen.getByLabelText('ملاحظة فرق كلور حبيبات'), {
    target: { value: 'كيس ممزق' },
  });
}

describe('Stock counts: review and post', () => {
  it('the reviewer sees the differences; a difference without a reason blocks posting', async () => {
    const bridge = bridgeFor(REVIEWER, '/stock/counts/40')
      .on('GET', '/api/v1/stock/counts/40', ok(reviewed))
      .on('POST', '/api/v1/stock/counts/40/post', ok(postedCount));
    await signIn(bridge, 'جرد');
    const table = await screen.findByRole('table', { name: 'فروق الجرد' });
    const chlorine = within(table).getByText('كلور حبيبات').closest('tr')!;
    expect(within(chlorine).getByText('10')).toBeTruthy(); // system
    expect(within(chlorine).getByText('9')).toBeTruthy(); // counted
    expect(within(chlorine).getByText('-1')).toBeTruthy(); // difference
    expect(within(chlorine).getByText('-125.00')).toBeTruthy(); // value (stock.view_cost)
    const salt = within(table).getByText('ملح المسابح').closest('tr')!;
    expect(within(salt).getByText('-0.5')).toBeTruthy(); // moved since the start
    expect(within(salt).getByText('لا فرق')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'ترحيل الجرد' }));
    expect(await screen.findByText('اختر سببًا لكل فرق قبل الترحيل.')).toBeTruthy();
    expect(screen.getByText('اختر سببًا لهذا الفرق.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/stock/counts/40/post')).toHaveLength(0);

    await chooseReason();
    fireEvent.click(screen.getByRole('button', { name: 'ترحيل الجرد' }));
    expect(await screen.findByText('رُحّل الجرد.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/stock/counts/40/post')[0]!.body).toEqual({
      reasons: [{ lineId: '401', reasonCodeId: '72', note: 'كيس ممزق' }],
      rowVersion: 5,
    });
    expect(await screen.findByText('CNT-000001', { selector: 'h1 bdi' })).toBeTruthy();
  });

  it('above the limit: the supervisor approves, then the same post is sent with the approval', async () => {
    const bridge = bridgeFor(REVIEWER, '/stock/counts/40')
      .on('GET', '/api/v1/stock/counts/40', ok(reviewed))
      .on(
        'POST',
        '/api/v1/stock/counts/40/post',
        failure(403, 'RULE_VIOLATION', { rule: 'APPROVAL_REQUIRED' }),
        ok(postedCount),
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
    await signIn(bridge, 'جرد');
    await screen.findByRole('table', { name: 'فروق الجرد' });
    await chooseReason();
    fireEvent.click(screen.getByRole('button', { name: 'ترحيل الجرد' }));

    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'خالد سالم' });
    fireEvent.change(within(dialog).getByLabelText('المشرف'), { target: { value: '8' } });
    fireEvent.change(within(dialog).getByLabelText(/الرمز السري للمشرف/), {
      target: { value: '4826' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^السبب/), {
      target: { value: 'كيس ممزق في المستودع' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'موافقة' }));
    expect(await screen.findByText('رُحّل الجرد.')).toBeTruthy();

    const approval = bridge.callsTo('POST', '/api/v1/approvals')[0]!;
    expect(approval.body).toMatchObject({
      permission: 'stock.adjust_over_threshold',
      approverId: '8',
    });
    const posts = bridge.callsTo('POST', '/api/v1/stock/counts/40/post');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual({
      reasons: [{ lineId: '401', reasonCodeId: '72', note: 'كيس ممزق' }],
      rowVersion: 5,
      approvalId: '555',
    });
  });
});

// ---------------------------------------------------------------------------------------------

const oversell: AdjustmentItem = {
  id: '60',
  docNumber: 'ADJ-000060',
  kind: 'oversell',
  status: 'posted',
  warehouseId: '1',
  date: '2026-10-12',
  reasonCodeId: '91',
  note: null,
  reviewStatus: 'pending',
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
  postedAt: '2026-10-12T06:00:00.000Z',
  postedBy: '5',
  lineCount: 1,
  journalEntryId: '701',
  rowVersion: 2,
};

describe('Oversell reviews', () => {
  it('shows a clear empty state when nothing waits', async () => {
    const bridge = bridgeFor(['stock.view', 'stock.oversell_review'], '/stock/reviews');
    await signIn(bridge, 'مراجعة البيع بدون رصيد');
    expect(await screen.findByText('لا توجد مبيعات بانتظار المراجعة.')).toBeTruthy();
    expect(bridge.callsTo('GET', '/api/v1/stock/adjustments')[0]!.path).toContain('kind=oversell');
    expect(bridge.callsTo('GET', '/api/v1/stock/adjustments')[0]!.path).toContain('review=pending');
  });

  it('"Mark reviewed" needs a note, then sends the note and the row version', async () => {
    const bridge = bridgeFor(['stock.view', 'stock.oversell_review'], '/stock/reviews')
      .on('GET', '/api/v1/stock/adjustments', (request: BridgeRequest) =>
        ok({ adjustments: request.path.includes('review=pending') ? [oversell] : [], total: 1 }),
      )
      .on(
        'GET',
        '/api/v1/stock/adjustments/60',
        ok({ ...oversell, journalEntryNumber: 'JE-000701', lines: [postedOpening.lines[0]!] }),
      )
      .on(
        'POST',
        '/api/v1/stock/adjustments/60/review',
        ok({ ...oversell, reviewStatus: 'reviewed' }),
      );
    await signIn(bridge, 'مراجعة البيع بدون رصيد');
    expect(await screen.findByText('كلور حبيبات')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل مراجعة ADJ-000060' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل المراجعة' }));
    expect(await within(dialog).findByText('اكتب ملاحظة من 3 أحرف على الأقل.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/stock/adjustments/60/review')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText(/ملاحظة المراجعة/), {
      target: { value: 'وُجدت في المستودع الخلفي' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل المراجعة' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.callsTo('POST', '/api/v1/stock/adjustments/60/review')[0]!.body).toEqual({
      note: 'وُجدت في المستودع الخلفي',
      rowVersion: 2,
    });
  });

  it('without stock.oversell_review there is no "Mark reviewed" button', async () => {
    const bridge = bridgeFor(['stock.view'], '/stock/reviews').on(
      'GET',
      '/api/v1/stock/adjustments',
      ok({ adjustments: [oversell], total: 1 }),
    );
    await signIn(bridge, 'مراجعة البيع بدون رصيد');
    expect(await screen.findByText('ADJ-000060')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /تسجيل مراجعة/ })).toBeNull();
  });
});
