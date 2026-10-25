/**
 * Labels for many items (decision 0099) against a scripted server: the "price changed" list with its
 * default counts (on hand for unit items, 0 when none, 1 for weight items), the category filter and
 * the total; more than 100 labels confirmed first; the print recorded with the price on each label
 * (only after the person says the dialog really printed); items added by search or scanner; the
 * items of a stock increase with one label per unit received; items whose price changed while
 * printing named.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdjustmentDetail,
  BridgeRequest,
  CategoryItem,
  LabelItem,
  LabelSizeItem,
  PriceChangedItem,
  UnitItem,
} from '@artepool/shared/contracts';
import { defaultLabelDesign } from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { FakeBridge, ok, sessionView, signInAnswer, userView } from '../support/fake-bridge';

const PERMISSIONS = ['items.view', 'stock.view', 'labels.print'];

const category = (id: string, code: string, ar: string, en: string): CategoryItem => ({
  id,
  parentId: null,
  code,
  nameAr: ar,
  nameEn: en,
  sortOrder: Number(id),
  isActive: true,
  rowVersion: 1,
});
const CATEGORIES = [
  category('1', 'CHEM', 'كيماويات', 'Chemicals'),
  category('2', 'EQUIP', 'معدات', 'Equipment'),
];

const unit = (id: string, code: string, ar: string, decimals: number): UnitItem => ({
  id,
  code,
  nameAr: ar,
  nameEn: code,
  decimals,
  einvoiceCode: null,
  isActive: true,
  rowVersion: 1,
});
const UNITS = [unit('1', 'PCS', 'قطعة', 0), unit('2', 'KG', 'كيلو', 3)];

const SIZES: LabelSizeItem[] = [
  {
    id: '5',
    code: '50X30',
    nameAr: 'أساسي',
    nameEn: 'Standard',
    widthMm: 50,
    heightMm: 30,
    sortOrder: 1,
    isActive: true,
    rowVersion: 1,
  },
];

const item = (patch: Partial<LabelItem>): LabelItem => ({
  id: '10',
  code: 'CHEM-0010',
  nameAr: 'كلور أقراص',
  nameEn: 'Chlorine tablets',
  primaryBarcode: '6291041500213',
  price: { price4dp: '1200000', includesVat: true },
  rateBp: 500,
  packAr: null,
  packEn: null,
  unitId: '1',
  unitDecimals: 0,
  categoryId: '1',
  isActive: true,
  onHandMilli: '7000',
  ...patch,
});

const changed = (patch: Partial<LabelItem>, oldGross: string): PriceChangedItem => ({
  ...item(patch),
  printed: {
    price4dp: '1000000',
    includesVat: true,
    rateBp: 500,
    grossFils: oldGross,
    printedAt: '2026-10-01T08:00:00.000Z',
  },
  nowGrossFils: '12000',
});

const CHANGED = [
  changed({}, '10000'),
  changed({ id: '11', code: 'CHEM-0011', nameAr: 'كلور سائل', onHandMilli: '-2000' }, '9000'),
  changed(
    {
      id: '12',
      code: 'EQUIP-0001',
      nameAr: 'رمل فلتر',
      unitId: '2',
      unitDecimals: 3,
      categoryId: '2',
    },
    '500',
  ),
];

const ADJUSTMENT: AdjustmentDetail = {
  id: '3',
  docNumber: 'ADJ-000003',
  kind: 'increase',
  status: 'posted',
  warehouseId: '1',
  date: '2026-10-19',
  reasonCodeId: '32',
  note: null,
  reviewStatus: 'not_required',
  reviewNote: null,
  reviewedBy: null,
  reviewedAt: null,
  postedAt: '2026-10-19T08:00:00Z',
  postedBy: '5',
  postedByName: { displayNameAr: 'سالم', displayNameEn: 'Salem' },
  reviewedByName: null,
  approvedByName: null,
  lineCount: 2,
  journalEntryId: '9',
  rowVersion: 1,
  journalEntryNumber: 'JE-000009',
  lines: [
    {
      lineNo: 1,
      itemId: '10',
      itemCode: 'CHEM-0010',
      nameAr: 'كلور أقراص',
      nameEn: 'Chlorine tablets',
      unitId: '1',
      stockStatus: 'available',
      targetStatus: null,
      quantityMilli: '5000',
      note: null,
    },
    {
      lineNo: 2,
      itemId: '12',
      itemCode: 'EQUIP-0001',
      nameAr: 'رمل فلتر',
      nameEn: 'Filter sand',
      unitId: '2',
      stockStatus: 'available',
      targetStatus: null,
      quantityMilli: '2500',
      note: null,
    },
  ],
};

function bridge(options: { priceChanged?: string[] } = {}) {
  return new FakeBridge()
    .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer({}, { displayNameAr: 'محمد ياسر' })))
    .on(
      'GET',
      '/api/v1/auth/me',
      ok({
        session: sessionView(),
        user: userView({ displayNameAr: 'محمد ياسر', displayNameEn: 'Mohammed Yasser' }),
        device: { id: '2', code: 'OFFICE-01', name: 'Owner office', kind: 'office' },
        permissions: PERMISSIONS,
      }),
    )
    .on('GET', '/api/v1/item-categories', ok({ categories: CATEGORIES }))
    .on('GET', '/api/v1/units', ok({ units: UNITS }))
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
    .on('GET', '/api/v1/business-lines', ok({ businessLines: [] }))
    .on('GET', '/api/v1/reason-codes', ok({ reasonCodes: [] }))
    .on('GET', '/api/v1/label-sizes', ok({ labelSizes: SIZES, maxWidthMm: 50 }))
    .on(
      'GET',
      '/api/v1/label-design',
      ok({
        versionId: '9',
        versionNo: 1,
        savedAt: '2026-10-20T08:00:00.000Z',
        savedBy: null,
        design: defaultLabelDesign(),
        shopName: { ar: 'آرتيبول', en: 'ARTEPOOL' },
        canEdit: false,
      }),
    )
    .on('GET', '/api/v1/stock/summary', ok({ toReorder: 0, defectiveItems: 0, pendingReviews: 0 }))
    .on('GET', '/api/v1/items', (request: BridgeRequest) => {
      const q = new URLSearchParams(request.path.split('?')[1]).get('q');
      const hit = q === '6291041500213' || q === 'CHEM-0010';
      return ok({
        items: [],
        total: 0,
        counts: { active: 0, stock: 0, service: 0, bundle: 0 },
        exactMatchId: hit ? '10' : null,
      });
    })
    .on('GET', '/api/v1/label-items', (request: BridgeRequest) => {
      const ids = new URLSearchParams(request.path.split('?')[1]).get('ids')!.split(',');
      const all = [
        item({}),
        item({ id: '12', code: 'EQUIP-0001', nameAr: 'رمل فلتر', unitId: '2', unitDecimals: 3 }),
      ];
      return ok({ items: all.filter((i) => ids.includes(i.id)) });
    })
    .on('GET', '/api/v1/label-prints/price-changed', (request: BridgeRequest) => {
      const categoryId = new URLSearchParams(request.path.split('?')[1]).get('categoryId');
      return ok({ items: CHANGED.filter((i) => !categoryId || i.categoryId === categoryId) });
    })
    .on(
      'GET',
      '/api/v1/stock/adjustments',
      ok({ adjustments: [{ ...ADJUSTMENT, lines: undefined }], total: 1 }),
    )
    .on('GET', '/api/v1/stock/adjustments/3', ok(ADJUSTMENT))
    .on('POST', '/api/v1/label-prints', (request: BridgeRequest) => {
      const body = request.body as { lines: { itemId: string }[] };
      const refused = options.priceChanged ?? [];
      return ok(
        {
          recorded: body.lines.map((l) => l.itemId).filter((id) => !refused.includes(id)),
          priceChanged: refused,
        },
        201,
      );
    });
}

async function openBatch(fake: FakeBridge) {
  render(<App bridge={fake} />);
  await screen.findByRole('heading', { level: 1 });
  fireEvent.change(screen.getByLabelText('اسم المستخدم'), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'blue-pool-water' } });
  fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
  await screen.findByRole('heading', { name: 'أهلًا، محمد ياسر' });
  fireEvent.click(screen.getByRole('link', { name: 'الأصناف والمخزون' }));
  fireEvent.click(await screen.findByRole('button', { name: 'ملصقات لأصناف كتير' }));
  return screen.findByRole('dialog', { name: 'ملصقات لأصناف كتير' });
}

const countOf = (dialog: HTMLElement, name: string) =>
  within(dialog).getByLabelText<HTMLInputElement>(`عدد ملصقات ${name}`);

/** The print dialog: printed at once; then the person says it printed. */
function stubPrint() {
  return vi.spyOn(window, 'print').mockImplementation(() => {
    setTimeout(() => window.dispatchEvent(new Event('afterprint')), 0);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Labels for many items: the "price changed" list', () => {
  it('default counts, category filter, total; recorded with the price on each label', async () => {
    const fake = bridge();
    const dialog = await openBatch(fake);
    fireEvent.click(within(dialog).getByRole('button', { name: 'السعر اتغيّر' }));
    // On hand 7 → 7 labels; on hand below zero → 0; sold by weight → 1.
    await waitFor(() => expect(countOf(dialog, 'كلور أقراص').value).toBe('7'));
    expect(countOf(dialog, 'كلور سائل').value).toBe('0');
    expect(countOf(dialog, 'رمل فلتر').value).toBe('1');
    expect(within(dialog).getByTestId('labels-total').textContent).toBe('المجموع: 8 ملصق');
    // Old → new price with VAT.
    expect(within(dialog).getByTestId('labels-line-CHEM-0010').textContent).toContain(
      '100.00 ← 120.00',
    );

    // By category: equipment only.
    fireEvent.change(within(dialog).getByLabelText('التصنيف'), { target: { value: '2' } });
    await waitFor(() =>
      expect(fake.callsTo('GET', '/api/v1/label-prints/price-changed').at(-1)?.path).toContain(
        'categoryId=2',
      ),
    );
    await waitFor(() =>
      expect(within(dialog).queryByLabelText('عدد ملصقات كلور أقراص')).toBeNull(),
    );
    fireEvent.change(within(dialog).getByLabelText('التصنيف'), { target: { value: '' } });
    await waitFor(() => expect(countOf(dialog, 'كلور أقراص').value).toBe('7'));

    const print = stubPrint();
    fireEvent.click(within(dialog).getByRole('button', { name: 'اطبع 8 ملصق' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    // Nothing recorded until the person says the labels printed.
    await within(dialog).findByText('اتطبعت الـ 8 ملصق؟');
    expect(fake.callsTo('POST', '/api/v1/label-prints')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'أيوه، اتطبعت' }));
    await waitFor(() => expect(fake.callsTo('POST', '/api/v1/label-prints')).toHaveLength(1));
    const call = fake.callsTo('POST', '/api/v1/label-prints')[0]!;
    // The item with 0 labels is neither printed nor recorded.
    expect(call.body).toEqual({
      sizeId: '5',
      designVersionId: '9',
      source: 'price_changed',
      lines: [
        {
          itemId: '10',
          copies: 7,
          price: { price4dp: '1200000', includesVat: true, rateBp: 500 },
        },
        {
          itemId: '12',
          copies: 1,
          price: { price4dp: '1200000', includesVat: true, rateBp: 500 },
        },
      ],
    });
    expect(call.idempotencyKey).toBeTruthy();
  });

  it('more than 100 labels: asked first; items whose price changed meanwhile are named', async () => {
    const fake = bridge({ priceChanged: ['10'] });
    const dialog = await openBatch(fake);
    fireEvent.click(within(dialog).getByRole('button', { name: 'السعر اتغيّر' }));
    await waitFor(() => expect(countOf(dialog, 'كلور أقراص').value).toBe('7'));
    fireEvent.change(countOf(dialog, 'كلور أقراص'), { target: { value: '150' } });
    expect(within(dialog).getByTestId('labels-total').textContent).toBe('المجموع: 151 ملصق');
    const print = stubPrint();
    fireEvent.click(within(dialog).getByRole('button', { name: 'اطبع 151 ملصق' }));
    expect(within(dialog).getByText(/هتطبع 151 ملصق. متأكد؟/)).toBeTruthy();
    expect(print).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'أيوه، اطبع' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'أيوه، اتطبعت' }));
    expect(
      await within(dialog).findByText(
        'الأصناف دي سعرها اتغيّر وقت الطباعة، فطباعتها ما اتسجلتش: CHEM-0010. اطبع ملصقاتها تاني.',
      ),
    ).toBeTruthy();
  });

  it('a count that is not a whole number blocks printing', async () => {
    const dialog = await openBatch(bridge());
    fireEvent.click(within(dialog).getByRole('button', { name: 'السعر اتغيّر' }));
    await waitFor(() => expect(countOf(dialog, 'كلور أقراص').value).toBe('7'));
    fireEvent.change(countOf(dialog, 'كلور أقراص'), { target: { value: '2.5' } });
    expect(
      within(dialog).getByText('عدد الملصقات لازم يكون رقم صحيح (0 يعني ما يتطبعش).'),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /^اطبع/ }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});

describe('Labels for many items: by hand and from a stock document', () => {
  it('a scanned barcode adds the item; scanning it again adds one more label', async () => {
    const dialog = await openBatch(bridge());
    const search = within(dialog).getByLabelText('دوّر على صنف أو امسح الباركود');
    for (let i = 0; i < 2; i += 1) {
      fireEvent.change(search, { target: { value: '6291041500213' } });
      fireEvent.keyDown(search, { key: 'Enter' });
      await waitFor(() => expect(countOf(dialog, 'كلور أقراص').value).toBe(String(i + 1)));
    }
    expect(within(dialog).getByTestId('labels-total').textContent).toBe('المجموع: 2 ملصق');
  });

  it('a stock increase: one label per unit received, one for a weight item', async () => {
    const dialog = await openBatch(bridge());
    fireEvent.click(within(dialog).getByRole('button', { name: 'من تسوية زيادة أو رصيد افتتاحي' }));
    const doc = within(dialog).getByLabelText('المستند');
    await waitFor(() => expect(within(doc).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(doc, { target: { value: '3' } });
    await waitFor(() => expect(countOf(dialog, 'كلور أقراص').value).toBe('5'));
    expect(countOf(dialog, 'رمل فلتر').value).toBe('1');
    expect(within(dialog).getByTestId('labels-total').textContent).toBe('المجموع: 6 ملصق');
  });
});
