/**
 * M2-T9: the Items & stock screen (design 07) against a scripted server: who sees which buttons,
 * creating a stock item and a kit (exact request bodies: prices in 4 decimals, quantities in
 * thousandths), the price with and without VAT, "changed by someone else", deactivating with a
 * reason.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  BridgeRequest,
  BusinessLineItem,
  CategoryItem,
  ItemDetail,
  ItemListItem,
  ItemsResponse,
  UnitItem,
  VatCategoryItem,
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

const OWNER = ['items.view', 'items.manage', 'prices.manage', 'data.import'];

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
  {
    id: '2',
    parentId: null,
    code: 'EQUIP',
    nameAr: 'معدات',
    nameEn: 'Equipment',
    sortOrder: 2,
    isActive: true,
    rowVersion: 1,
  },
  {
    id: '3',
    parentId: '1',
    code: 'CHLOR',
    nameAr: 'كلور',
    nameEn: 'Chlorine',
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

const vatCategory = (patch: Partial<VatCategoryItem>): VatCategoryItem => ({
  id: '1',
  code: 'SR',
  nameAr: 'قياسي',
  nameEn: 'Standard',
  rateBp: 500,
  rowVersion: 1,
  ...patch,
});

const VAT = {
  categories: [
    vatCategory({}),
    vatCategory({ id: '2', code: 'ZR', nameAr: 'صفري', nameEn: 'Zero-rated', rateBp: 0 }),
    vatCategory({ id: '3', code: 'EX', nameAr: 'معفى', nameEn: 'Exempt', rateBp: 0 }),
    vatCategory({ id: '4', code: 'OS', nameAr: 'خارج النطاق', nameEn: 'Out of scope', rateBp: 0 }),
  ],
  einvoiceMandatoryFrom: null,
};

const LINES: BusinessLineItem[] = [
  {
    id: '1',
    code: 'RETAIL',
    nameAr: 'البيع بالتجزئة',
    nameEn: 'Retail',
    revenueAccountId: '41',
    cogsAccountId: '51',
    sortOrder: 1,
    isActive: true,
    rowVersion: 1,
  },
];

const detail = (patch: Partial<ItemDetail>): ItemDetail => ({
  id: '10',
  code: 'CHEM-0012',
  itemType: 'stock',
  nameAr: 'كلور حبيبات 10 كجم',
  nameEn: 'Granular chlorine 10 kg',
  categoryId: '3',
  unitId: '1',
  vatCategoryId: '1',
  price: { price4dp: '125000', includesVat: false },
  primaryBarcode: '6291100000012',
  isSellable: true,
  isActive: true,
  descriptionAr: null,
  descriptionEn: null,
  defaultBusinessLineId: '1',
  reorderLevelMilli: '5000',
  reorderQtyMilli: null,
  barcodes: [{ id: '1', barcode: '6291100000012', qtyPerScanMilli: '1000', isPrimary: true }],
  components: [],
  inUse: null,
  rowVersion: 3,
  ...patch,
});

const CHLORINE = detail({});
const PUMP = detail({
  id: '11',
  code: 'EQUIP-0003',
  nameAr: 'مضخة أرضية',
  nameEn: 'Floor pump',
  categoryId: '2',
  price: { price4dp: '99900', includesVat: true },
  primaryBarcode: null,
  barcodes: [],
  defaultBusinessLineId: null,
  reorderLevelMilli: null,
  rowVersion: 1,
});

const listed = (item: ItemDetail): ItemListItem => ({
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
});

const itemsAnswer = (items: ItemDetail[]): ItemsResponse => ({
  items: items.map(listed),
  total: items.length,
  counts: { active: 41, stock: 30, service: 8, bundle: 3 },
});

function bridgeFor(permissions: string[], language: 'ar' | 'en' = 'ar') {
  return new FakeBridge()
    .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer({}, { displayNameAr: 'محمد ياسر' })))
    .on(
      'GET',
      '/api/v1/auth/me',
      ok({
        session: sessionView(),
        user: userView({
          displayNameAr: 'محمد ياسر',
          displayNameEn: 'Mohammed Yasser',
          language,
        }),
        device: { id: '2', code: 'OFFICE-01', name: 'Owner office', kind: 'office' },
        permissions,
      }),
    )
    .on('GET', '/api/v1/item-categories', ok({ categories: CATEGORIES }))
    .on('GET', '/api/v1/units', ok({ units: UNITS }))
    .on('GET', '/api/v1/settings/vat', ok(VAT))
    .on('GET', '/api/v1/business-lines', ok({ businessLines: LINES }))
    .on('GET', '/api/v1/items', (request: BridgeRequest) => {
      const q = new URLSearchParams(request.path.split('?')[1]).get('q');
      if (q) return ok(itemsAnswer([CHLORINE, PUMP].filter((i) => i.nameAr.includes(q))));
      return ok(itemsAnswer([CHLORINE, PUMP]));
    })
    .on('GET', '/api/v1/items/10', ok(CHLORINE))
    .on('GET', '/api/v1/items/11', ok(PUMP));
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

/** The list row whose bold title is `name`. */
async function row(name: string): Promise<HTMLElement> {
  const title = await screen.findByText(name, { selector: 'tbody b' });
  return title.closest('tr')!;
}

/** The detail panel's card for the item called `name`. */
async function detailCard(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name, level: 2 });
  return heading.closest('aside')!;
}

describe('Items & stock: the list', () => {
  it('a storekeeper with items.view only sees the list, but no New, Import or Edit', async () => {
    await openItems(bridgeFor(['items.view']));
    expect(await row('كلور حبيبات 10 كجم')).toBeTruthy();
    expect(within(await row('مضخة أرضية')).getByText('صنف مخزني')).toBeTruthy();
    const card = await detailCard('كلور حبيبات 10 كجم');
    expect(within(card).getByText('مفعّل')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'صنف جديد' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'استيراد أصناف' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'استيراد أسعار' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'تعديل' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'إيقاف' })).toBeNull();
  });

  it('shows the summary tiles and one filter per top-level category', async () => {
    await openItems(bridgeFor(OWNER));
    expect(await screen.findByText('41')).toBeTruthy();
    expect(screen.getByText('أطقم')).toBeTruthy();
    const filters = screen.getByRole('group', { name: 'التصنيف' });
    expect(
      within(filters)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['الكل', 'كيماويات', 'معدات', 'موقوفة']);
    expect(screen.getByRole('button', { name: 'استيراد أصناف' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'استيراد أسعار' })).toBeTruthy();
  });

  it('searches by name (after typing stops), filters by category; F2 focuses the search', async () => {
    const bridge = bridgeFor(OWNER);
    await openItems(bridge);
    await row('مضخة أرضية');
    const search = screen.getByRole('searchbox', { name: 'الاسم أو الكود أو الباركود' });
    fireEvent.keyDown(window, { key: 'F2' });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: 'مضخة' } });
    await waitFor(() =>
      expect(bridge.callsTo('GET', '/api/v1/items').at(-1)?.path).toContain(
        `q=${encodeURIComponent('مضخة')}`,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText('كلور حبيبات 10 كجم', { selector: 'tbody b' })).toBeNull(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'معدات' }));
    await waitFor(() =>
      expect(bridge.callsTo('GET', '/api/v1/items').at(-1)?.path).toContain('categoryId=2'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'موقوفة' }));
    await waitFor(() =>
      expect(bridge.callsTo('GET', '/api/v1/items').at(-1)?.path).toContain('status=inactive'),
    );
  });

  it('shows each price with and without VAT (an exclusive price gets 5% added)', async () => {
    await openItems(bridgeFor(OWNER));
    // 12.50 excluding VAT → VAT 0.625 rounds half away from zero to 0.63 → 13.13.
    const chlorine = await row('كلور حبيبات 10 كجم');
    expect(within(chlorine).getByText('13.13')).toBeTruthy();
    expect(within(chlorine).getByText('12.50')).toBeTruthy();
    // 9.99 including VAT → VAT 0.48, net 9.51.
    const pump = await row('مضخة أرضية');
    expect(within(pump).getByText('9.99')).toBeTruthy();
    expect(within(pump).getByText('9.51')).toBeTruthy();
  });

  it('the detail panel splits an inclusive price back into net, VAT and total', async () => {
    await openItems(bridgeFor(OWNER));
    fireEvent.click(await row('مضخة أرضية'));
    const card = await detailCard('مضخة أرضية');
    const figures = within(card).getByTestId('price-figures');
    expect(within(figures).getByText('9.51')).toBeTruthy();
    expect(within(figures).getByText('0.48')).toBeTruthy();
    expect(within(figures).getByText('9.99')).toBeTruthy();
    const vatRow = within(card).getByText('فئة الضريبة').closest('div')!;
    expect(vatRow.textContent).toBe('فئة الضريبةقياسي · 5%');
    expect(within(card).getByText('السعر يشمل الضريبة').closest('div')!.textContent).toContain(
      'نعم',
    );
  });
});

describe('Items & stock: the item form', () => {
  it('the owner creates a stock item: code suggested from the category, exact amounts sent', async () => {
    const created = detail({
      id: '12',
      code: 'CHEM-0013',
      nameAr: 'كلور سائل',
      nameEn: 'Liquid chlorine',
      categoryId: '1',
      price: { price4dp: '125000', includesVat: true },
      primaryBarcode: '6291234567890',
      barcodes: [{ id: '5', barcode: '6291234567890', qtyPerScanMilli: '1000', isPrimary: true }],
      defaultBusinessLineId: null,
      rowVersion: 1,
    });
    const bridge = bridgeFor(OWNER)
      .on('GET', '/api/v1/items/next-code', ok({ code: 'CHEM-0013' }))
      .on('POST', '/api/v1/items', ok(created, 201))
      .on('GET', '/api/v1/items/12', ok(created));
    await openItems(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'صنف جديد' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('التصنيف'), { target: { value: '1' } });
    await waitFor(() =>
      expect(within(dialog).getByLabelText<HTMLInputElement>('الكود').value).toBe('CHEM-0013'),
    );
    expect(bridge.callsTo('GET', '/api/v1/items/next-code')[0]?.path).toBe(
      '/api/v1/items/next-code?categoryId=1',
    );
    fireEvent.change(within(dialog).getByLabelText('الاسم بالعربية'), {
      target: { value: 'كلور سائل' },
    });
    fireEvent.change(within(dialog).getByLabelText('الاسم بالإنجليزية'), {
      target: { value: 'Liquid chlorine' },
    });
    fireEvent.change(within(dialog).getByLabelText('سعر البيع'), { target: { value: '12.5' } });
    expect(within(dialog).getByRole('switch', { name: 'السعر يشمل الضريبة' })).toBeTruthy();
    // 12.50 including 5% VAT → 11.90 + 0.60.
    const line = within(dialog).getByTestId('price-line');
    expect(line.textContent).toBe('قبل الضريبة: 11.90 · الضريبة: 0.60 · الإجمالي: 12.50 درهم');
    fireEvent.change(within(dialog).getByLabelText('حد إعادة الطلب'), { target: { value: '5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إضافة باركود' }));
    fireEvent.change(within(dialog).getByLabelText('الباركود 1'), {
      target: { value: '6291234567890' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الصنف' }));

    expect(await screen.findByText('تم الحفظ.')).toBeTruthy();
    const call = bridge.callsTo('POST', '/api/v1/items')[0]!;
    expect(call.body).toEqual({
      code: 'CHEM-0013',
      itemType: 'stock',
      nameAr: 'كلور سائل',
      nameEn: 'Liquid chlorine',
      descriptionAr: null,
      descriptionEn: null,
      categoryId: '1',
      unitId: '1',
      vatCategoryId: '1',
      defaultBusinessLineId: null,
      reorderLevelMilli: '5000',
      reorderQtyMilli: null,
      isSellable: true,
      price: { price4dp: '125000', includesVat: true },
      barcodes: [{ barcode: '6291234567890', qtyPerScanMilli: '1000', isPrimary: true }],
      components: [],
    });
    expect(call.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await detailCard('كلور سائل')).toBeTruthy();
  });

  it('the owner types the purchase price (without VAT): profit is shown, and it is sent exactly', async () => {
    const created = detail({
      id: '12',
      code: 'CHEM-0013',
      nameAr: 'كلور سائل',
      nameEn: 'Liquid chlorine',
      categoryId: '1',
      price: { price4dp: '125000', includesVat: true },
      purchaseCost4dp: '50000',
      rowVersion: 1,
    });
    const bridge = bridgeFor([...OWNER, 'items.cost'])
      .on('GET', '/api/v1/items/next-code', ok({ code: 'CHEM-0013' }))
      .on('POST', '/api/v1/items', ok(created, 201))
      .on('GET', '/api/v1/items/12', ok(created));
    await openItems(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'صنف جديد' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('التصنيف'), { target: { value: '1' } });
    await waitFor(() =>
      expect(within(dialog).getByLabelText<HTMLInputElement>('الكود').value).toBe('CHEM-0013'),
    );
    fireEvent.change(within(dialog).getByLabelText('الاسم بالعربية'), {
      target: { value: 'كلور سائل' },
    });
    fireEvent.change(within(dialog).getByLabelText('الاسم بالإنجليزية'), {
      target: { value: 'Liquid chlorine' },
    });
    fireEvent.change(within(dialog).getByLabelText('سعر البيع'), { target: { value: '12.5' } });
    // A wrong purchase price is refused on this PC, with nothing sent.
    fireEvent.change(within(dialog).getByLabelText('سعر الشراء (بدون ضريبة)'), {
      target: { value: '5,5x' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الصنف' }));
    expect(await within(dialog).findByText(/اكتب سعرًا صحيحًا/)).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/items')).toHaveLength(0);
    // Sells at 12.50 including 5% VAT → 11.90 without; bought at 5.00 → profit 6.90 = 58.0%.
    fireEvent.change(within(dialog).getByLabelText('سعر الشراء (بدون ضريبة)'), {
      target: { value: '5' },
    });
    expect(within(dialog).getByTestId('profit-line').textContent).toBe(
      'الربح للوحدة: 6.90 درهم · 58.0%',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الصنف' }));
    expect(await screen.findByText('تم الحفظ.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/items')[0]!.body).toMatchObject({
      price: { price4dp: '125000', includesVat: true },
      purchaseCost4dp: '50000',
    });
    // The detail panel shows the cost and the profit per unit.
    const card = await detailCard('كلور سائل');
    expect(within(card).getByText('سعر الشراء (بدون ضريبة)').closest('div')!.textContent).toContain(
      '5.00',
    );
    expect(within(card).getByText('الربح للوحدة').closest('div')!.textContent).toContain('6.90');
  });

  it('without items.cost the purchase price is nowhere: not in the form, not in the request', async () => {
    const created = detail({
      id: '12',
      code: 'CHEM-0013',
      nameAr: 'كلور سائل',
      nameEn: 'Liquid chlorine',
      categoryId: '1',
      rowVersion: 1,
    });
    const bridge = bridgeFor(OWNER)
      .on('GET', '/api/v1/items/next-code', ok({ code: 'CHEM-0013' }))
      .on('POST', '/api/v1/items', ok(created, 201))
      .on('GET', '/api/v1/items/12', ok(created));
    await openItems(bridge);
    expect(screen.queryByText('الربح للوحدة')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'صنف جديد' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('سعر الشراء (بدون ضريبة)')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('التصنيف'), { target: { value: '1' } });
    await waitFor(() =>
      expect(within(dialog).getByLabelText<HTMLInputElement>('الكود').value).toBe('CHEM-0013'),
    );
    fireEvent.change(within(dialog).getByLabelText('الاسم بالعربية'), {
      target: { value: 'كلور سائل' },
    });
    fireEvent.change(within(dialog).getByLabelText('الاسم بالإنجليزية'), {
      target: { value: 'Liquid chlorine' },
    });
    fireEvent.change(within(dialog).getByLabelText('سعر البيع'), { target: { value: '12.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الصنف' }));
    await screen.findByText('تم الحفظ.');
    expect('purchaseCost4dp' in (bridge.callsTo('POST', '/api/v1/items')[0]!.body as object)).toBe(
      false,
    );
  });

  it('a kit has no purchase price field: its cost is worked out from its components', async () => {
    const bridge = bridgeFor([...OWNER, 'items.cost']);
    await openItems(bridge);
    fireEvent.click(await row('كلور حبيبات 10 كجم'));
    await detailCard('كلور حبيبات 10 كجم');
    fireEvent.click(screen.getByRole('button', { name: 'تعديل' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('سعر الشراء (بدون ضريبة)')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'طقم' }));
    expect(within(dialog).queryByLabelText('سعر الشراء (بدون ضريبة)')).toBeNull();
    expect(within(dialog).getByText(/تكلفة الطقم تُحسب من مكوناته/)).toBeTruthy();
  });

  it('checks the form before sending: required names, a valid price, the unit decimals', async () => {
    const bridge = bridgeFor(OWNER).on('GET', '/api/v1/items/next-code', ok({ code: 'CHEM-0013' }));
    await openItems(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'صنف جديد' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('سعر البيع'), { target: { value: '12.34567' } });
    fireEvent.change(within(dialog).getByLabelText('حد إعادة الطلب'), { target: { value: '2.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الصنف' }));
    expect(await within(dialog).findByText('صحّح الحقول المحددة ثم احفظ.')).toBeTruthy();
    expect(within(dialog).getAllByText('إلزامي.').length).toBeGreaterThanOrEqual(3);
    expect(
      within(dialog).getByText('اكتب سعرًا صحيحًا بأربعة أرقام عشرية على الأكثر، مثل 12.50'),
    ).toBeTruthy();
    expect(
      within(dialog).getByText('الكمية فيها أرقام عشرية أكثر مما تسمح به وحدتها.'),
    ).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/items')).toHaveLength(0);
  });

  it('creates a kit from searched components (kits and the kit itself are not offered)', async () => {
    const kit = detail({
      id: '13',
      code: 'CHEM-0014',
      itemType: 'bundle',
      nameAr: 'طقم تنظيف',
      nameEn: 'Cleaning kit',
      categoryId: '1',
      isSellable: false,
      price: null,
      barcodes: [],
      primaryBarcode: null,
      reorderLevelMilli: null,
      components: [
        {
          itemId: '10',
          code: 'CHEM-0012',
          nameAr: CHLORINE.nameAr,
          nameEn: CHLORINE.nameEn,
          unitId: '1',
          quantityMilli: '2000',
        },
      ],
    });
    const bridge = bridgeFor(OWNER)
      .on('GET', '/api/v1/items/next-code', ok({ code: 'CHEM-0014' }))
      .on('POST', '/api/v1/items', ok(kit, 201))
      .on('GET', '/api/v1/items/13', ok(kit));
    await openItems(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'صنف جديد' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'طقم' }));
    fireEvent.change(within(dialog).getByLabelText('التصنيف'), { target: { value: '1' } });
    await waitFor(() =>
      expect(within(dialog).getByLabelText<HTMLInputElement>('الكود').value).toBe('CHEM-0014'),
    );
    fireEvent.change(within(dialog).getByLabelText('الاسم بالعربية'), {
      target: { value: 'طقم تنظيف' },
    });
    fireEvent.change(within(dialog).getByLabelText('الاسم بالإنجليزية'), {
      target: { value: 'Cleaning kit' },
    });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'معروض للبيع' }));
    expect(within(dialog).queryByLabelText('حد إعادة الطلب')).toBeNull();

    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'ابحث عن صنف لإضافته' }), {
      target: { value: 'كلور' },
    });
    const results = await within(dialog).findByRole('list', { name: 'نتائج البحث' });
    fireEvent.click(await within(results).findByRole('button', { name: /كلور حبيبات 10 كجم/ }));
    fireEvent.change(within(dialog).getByLabelText('كمية كلور حبيبات 10 كجم'), {
      target: { value: '2' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الصنف' }));

    expect(await screen.findByText('تم الحفظ.')).toBeTruthy();
    const body = bridge.callsTo('POST', '/api/v1/items')[0]!.body as Record<string, unknown>;
    expect(body.itemType).toBe('bundle');
    expect(body.isSellable).toBe(false);
    expect(body.price).toBeNull();
    expect(body.reorderLevelMilli).toBeNull();
    expect(body.components).toEqual([{ itemId: '10', quantityMilli: '2000' }]);
    expect(bridge.callsTo('GET', '/api/v1/items').at(-1)?.path).toContain('status=active');
  });

  it('editing sends the row version; "changed by someone else" offers a reload', async () => {
    let current = CHLORINE;
    const bridge = bridgeFor(OWNER)
      .on('GET', '/api/v1/items/10', () => ok(current))
      .on(
        'PUT',
        '/api/v1/items/10',
        failure(409, 'STALE_VERSION'),
        ok(detail({ nameAr: 'كلور حبيبات 10 كجم (جديد)', rowVersion: 5 })),
      );
    await openItems(bridge);
    const card = await detailCard('كلور حبيبات 10 كجم');
    fireEvent.click(within(card).getByRole('button', { name: 'تعديل' }));
    const dialog = await screen.findByRole('dialog');
    const code = within(dialog).getByLabelText<HTMLInputElement>('الكود');
    expect(code.value).toBe('CHEM-0012');
    expect(code.disabled).toBe(true);
    expect(within(dialog).getByLabelText<HTMLInputElement>('سعر البيع').value).toBe('12.50');
    fireEvent.change(within(dialog).getByLabelText('الاسم بالعربية'), {
      target: { value: 'كلور حبيبات 10 كجم (جديد)' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الصنف' }));

    expect(await within(dialog).findByText(/عدّل شخص آخر هذه البيانات/)).toBeTruthy();
    const first = bridge.callsTo('PUT', '/api/v1/items/10')[0]!.body as Record<string, unknown>;
    expect(first.rowVersion).toBe(3);
    expect(first.price).toEqual({ price4dp: '125000', includesVat: false });
    expect(first).not.toHaveProperty('code');

    current = detail({ nameAr: 'كلور حبيبات 10 كجم - معدّل', rowVersion: 4 });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إعادة التحميل' }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText<HTMLInputElement>('الاسم بالعربية').value).toBe(
        'كلور حبيبات 10 كجم - معدّل',
      ),
    );
    expect(within(dialog).queryByText(/عدّل شخص آخر هذه البيانات/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الصنف' }));
    expect(await screen.findByText('تم الحفظ.')).toBeTruthy();
    const second = bridge.callsTo('PUT', '/api/v1/items/10')[1]!.body as Record<string, unknown>;
    expect(second.rowVersion).toBe(4);
  });

  it('without prices.manage the price is read-only and sent back unchanged', async () => {
    const bridge = bridgeFor(['items.view', 'items.manage']).on(
      'PUT',
      '/api/v1/items/10',
      ok(detail({ rowVersion: 4 })),
    );
    await openItems(bridge);
    const card = await detailCard('كلور حبيبات 10 كجم');
    fireEvent.click(within(card).getByRole('button', { name: 'تعديل' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText<HTMLInputElement>('سعر البيع').disabled).toBe(true);
    expect(within(dialog).getByText('تغيير السعر يحتاج صلاحية "إدارة الأسعار".')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الصنف' }));
    expect(await screen.findByText('تم الحفظ.')).toBeTruthy();
    const body = bridge.callsTo('PUT', '/api/v1/items/10')[0]!.body as Record<string, unknown>;
    expect(body.price).toEqual({ price4dp: '125000', includesVat: false });
  });

  it('a duplicate barcode from the server is shown under the barcodes', async () => {
    const bridge = bridgeFor(OWNER).on(
      'PUT',
      '/api/v1/items/10',
      failure(409, 'DUPLICATE', { field: 'barcodes' }),
    );
    await openItems(bridge);
    const card = await detailCard('كلور حبيبات 10 كجم');
    fireEvent.click(within(card).getByRole('button', { name: 'تعديل' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الصنف' }));
    expect(await within(dialog).findByText('مستخدم في سجل آخر.')).toBeTruthy();
  });
});

describe('Items & stock: deactivating', () => {
  it('needs a reason, sends it with the row version, and never deletes', async () => {
    const bridge = bridgeFor(OWNER).on(
      'POST',
      '/api/v1/items/10/deactivate',
      ok(detail({ isActive: false, rowVersion: 4 })),
    );
    await openItems(bridge);
    const card = await detailCard('كلور حبيبات 10 كجم');
    fireEvent.click(within(card).getByRole('button', { name: 'إيقاف' }));
    const dialog = await screen.findByRole('dialog', { name: 'إيقاف الصنف' });
    expect(within(dialog).getByText(/لا يُحذف الصنف لأن حركاته وفواتيره/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'إيقاف' }));
    expect(await within(dialog).findByText('اكتب سببًا من 3 أحرف على الأقل.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/items/10/deactivate')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText('السبب (إلزامي)'), {
      target: { value: 'توقف المورد عن توريده' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إيقاف' }));
    expect(await screen.findByText('تم الإيقاف.')).toBeTruthy();
    const call = bridge.callsTo('POST', '/api/v1/items/10/deactivate')[0]!;
    expect(call.body).toEqual({ reason: 'توقف المورد عن توريده', rowVersion: 3 });
    expect(call.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('Items & stock in English (left to right)', () => {
  it('shows the same list, prices and detail with English names', async () => {
    await initI18n('en');
    const bridge = bridgeFor(OWNER, 'en').on(
      'POST',
      '/api/v1/auth/sign-in',
      ok(signInAnswer({}, { displayNameEn: 'Mohammed Yasser', language: 'en' })),
    );
    render(<App bridge={bridge} />);
    await screen.findByRole('heading', { level: 1 });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'mohammed' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'blue-pool-water' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Welcome, Mohammed Yasser' });
    fireEvent.click(screen.getByRole('link', { name: 'Items & stock' }));
    await screen.findByRole('heading', { name: 'Items & stock', level: 1 });
    expect(document.documentElement.dir).toBe('ltr');
    const pump = await row('Floor pump');
    expect(within(pump).getByText('Stock item')).toBeTruthy();
    expect(within(pump).getByText('excl. VAT')).toBeTruthy();
    fireEvent.click(pump);
    const card = await detailCard('Floor pump');
    expect(within(within(card).getByTestId('price-figures')).getByText('Excl. VAT')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New item' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Name, code or barcode' })).toBeTruthy();
  });
});
