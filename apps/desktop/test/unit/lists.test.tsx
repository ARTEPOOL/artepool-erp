/**
 * T11: Settings → Lists (decision 0034) against a scripted server: tabs follow permissions, a new
 * unit, the VAT rate (owner only, with a reason; decision 0033), the default warehouse, and the
 * account a paid-out reason needs.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  AccountItem,
  ReasonCodeItem,
  UnitItem,
  VatCategoryItem,
  WarehouseItem,
} from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import {
  failure,
  FakeBridge,
  ok,
  sessionView,
  signInAnswer,
  userView,
} from '../support/fake-bridge';

const unit = (patch: Partial<UnitItem>): UnitItem => ({
  id: '1',
  code: 'PCS',
  nameAr: 'قطعة',
  nameEn: 'Piece',
  decimals: 0,
  einvoiceCode: 'H87',
  isActive: true,
  rowVersion: 1,
  ...patch,
});

const UNITS = [
  unit({}),
  unit({
    id: '2',
    code: 'KG',
    nameAr: 'كيلوغرام',
    nameEn: 'Kilogram',
    decimals: 3,
    einvoiceCode: 'KGM',
  }),
];

const vat = (patch: Partial<VatCategoryItem>): VatCategoryItem => ({
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
    vat({}),
    vat({ id: '2', code: 'ZR', nameAr: 'نسبة صفرية', nameEn: 'Zero-rated', rateBp: 0 }),
    vat({ id: '3', code: 'EX', nameAr: 'معفى', nameEn: 'Exempt', rateBp: 0 }),
    vat({ id: '4', code: 'OS', nameAr: 'خارج النطاق', nameEn: 'Out of scope', rateBp: 0 }),
  ],
  einvoiceMandatoryFrom: null,
};

const warehouse = (patch: Partial<WarehouseItem>): WarehouseItem => ({
  id: '1',
  code: 'MAIN',
  nameAr: 'المستودع الرئيسي',
  nameEn: 'Main store',
  warehouseType: 'store',
  technicianId: null,
  isDefault: true,
  isActive: true,
  rowVersion: 1,
  ...patch,
});

const WAREHOUSES = [
  warehouse({}),
  warehouse({
    id: '2',
    code: 'SITE-1',
    nameAr: 'موقع الجيمي',
    nameEn: 'Jimi site',
    warehouseType: 'site',
    isDefault: false,
    rowVersion: 3,
  }),
];

const account = (patch: Partial<AccountItem>): AccountItem => ({
  id: '1',
  code: '6000',
  nameAr: 'المصروفات التشغيلية',
  nameEn: 'Operating expenses',
  accountType: 'expense',
  parentId: null,
  isPostable: false,
  isControl: false,
  isContra: false,
  isActive: true,
  inUse: null,
  rowVersion: 1,
  ...patch,
});

const ACCOUNTS = {
  accounts: [
    account({}),
    account({
      id: '69',
      code: '6900',
      nameAr: 'مصروفات العهدة النقدية',
      nameEn: 'Petty cash expenses',
      parentId: '1',
      isPostable: true,
    }),
    account({
      id: '12',
      code: '1210',
      nameAr: 'ذمم العملاء',
      nameEn: 'Accounts receivable',
      accountType: 'asset',
      isPostable: true,
      isControl: true,
      inUse: 'event_link',
    }),
    account({
      id: '68',
      code: '6800',
      nameAr: 'الإهلاك',
      nameEn: 'Depreciation',
      parentId: '1',
      isPostable: true,
      isActive: false,
    }),
  ],
  links: [],
};

const reason = (patch: Partial<ReasonCodeItem>): ReasonCodeItem => ({
  id: '1',
  category: 'no_sale',
  code: 'NS-CHANGE',
  nameAr: 'فكة للعميل',
  nameEn: 'Change for a customer',
  requiresNote: false,
  glAccountId: null,
  isActive: true,
  rowVersion: 1,
  ...patch,
});

function signedInBridge(permissions: string[]) {
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
    .on('GET', '/api/v1/settings/vat', ok(VAT))
    .on('GET', '/api/v1/warehouses', ok({ warehouses: WAREHOUSES }))
    .on('GET', '/api/v1/technicians', ok({ technicians: [] }))
    .on('GET', '/api/v1/accounts', ok(ACCOUNTS))
    .on('GET', '/api/v1/reason-codes', ok({ reasonCodes: [reason({})] }));
}

async function signIn(bridge: FakeBridge) {
  render(<App bridge={bridge} />);
  await screen.findByRole('heading', { level: 1 });
  fireEvent.change(screen.getByLabelText('اسم المستخدم'), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'blue-pool-water' } });
  fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
  await screen.findByRole('heading', { name: 'أهلًا، محمد ياسر' });
}

/** Settings opens at the first allowed section; then the Lists section. */
async function openLists() {
  fireEvent.click(screen.getByRole('link', { name: 'الإعدادات' }));
  await screen.findByRole('navigation', { name: 'الإعدادات' });
  if (!screen.queryByRole('heading', { name: 'القوائم', level: 2 })) {
    fireEvent.click(screen.getByRole('link', { name: 'القوائم' }));
  }
  await screen.findByRole('heading', { name: 'القوائم', level: 2 });
}

const tabNames = () =>
  within(screen.getByRole('tablist', { name: 'القوائم' }))
    .getAllByRole('tab')
    .map((tab) => tab.textContent);

/** The table row whose code is `code` (waits for the list to load). */
async function row(code: string): Promise<HTMLElement> {
  const cell = await screen.findByText(code, { selector: 'tbody b bdi' });
  return cell.closest('tr')!;
}

describe('Settings → Lists', () => {
  it('shows only the tabs the person may use, and the VAT categories to everyone', async () => {
    await signIn(signedInBridge(['warehouses.manage']));
    await openLists();
    expect(tabNames()).toEqual(['فئات الضريبة', 'المستودعات']);
  });

  it('shows the item lists and reason codes to an owner without the other permissions', async () => {
    await signIn(signedInBridge(['items.manage', 'system.settings.edit']));
    await openLists();
    expect(tabNames()).toEqual(['الوحدات', 'فئات الأصناف', 'فئات الضريبة', 'رموز الأسباب']);
  });

  it('creates a unit with exactly the fields typed', async () => {
    const bridge = signedInBridge(['items.manage']);
    bridge.on('POST', '/api/v1/units', ok(unit({ id: '3', code: 'BKT' }), 201));
    await signIn(bridge);
    await openLists();
    expect(await row('KG')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'وحدة جديدة' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^الكود/), { target: { value: 'bkt' } });
    fireEvent.change(within(dialog).getByLabelText(/^الاسم بالعربية/), {
      target: { value: 'دلو' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^الاسم بالإنجليزية/), {
      target: { value: 'Bucket' },
    });
    fireEvent.change(within(dialog).getByLabelText('الأرقام العشرية في الكميات'), {
      target: { value: '2' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    await waitFor(() => expect(bridge.callsTo('POST', '/api/v1/units')).toHaveLength(1));
    expect(bridge.callsTo('POST', '/api/v1/units')[0]!.body).toEqual({
      code: 'BKT',
      nameAr: 'دلو',
      nameEn: 'Bucket',
      decimals: 2,
      einvoiceCode: null,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a unit code is fixed after creation, and editing sends the row version', async () => {
    const bridge = signedInBridge(['items.manage']);
    bridge.on('PATCH', '/api/v1/units/2', ok(unit({ id: '2' })));
    await signIn(bridge);
    await openLists();
    fireEvent.click(within(await row('KG')).getByRole('button', { name: 'تعديل KG' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/^الكود/)).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText(/^الاسم بالإنجليزية/), {
      target: { value: 'Kilo' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(bridge.callsTo('PATCH', '/api/v1/units/2')).toHaveLength(1));
    expect(bridge.callsTo('PATCH', '/api/v1/units/2')[0]!.body).toEqual({
      nameAr: 'كيلوغرام',
      nameEn: 'Kilo',
      decimals: 3,
      einvoiceCode: 'KGM',
      rowVersion: 1,
    });
  });

  it('only the owner changes the standard VAT rate, with a reason; "6" is sent as 600', async () => {
    const bridge = signedInBridge(['system.settings.edit']);
    bridge.on('PATCH', '/api/v1/settings/vat/1', ok(vat({ rateBp: 600, rowVersion: 2 })));
    await signIn(bridge);
    await openLists();
    fireEvent.click(screen.getByRole('tab', { name: 'فئات الضريبة' }));
    expect(await screen.findByText('5%')).toBeTruthy();
    // Zero-rated, exempt and out of scope never change: no button for them.
    expect(screen.queryByRole('button', { name: 'تغيير نسبة ZR' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'تغيير نسبة SR' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/على المستندات الجديدة فقط/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/^النسبة الجديدة/), { target: { value: '6' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تغيير النسبة' }));
    expect(await within(dialog).findByText('اكتب سببًا من 3 أحرف على الأقل.')).toBeTruthy();
    expect(bridge.callsTo('PATCH', '/api/v1/settings/vat/1')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText(/^السبب/), {
      target: { value: 'تعديل القانون' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تغيير النسبة' }));
    await waitFor(() => expect(bridge.callsTo('PATCH', '/api/v1/settings/vat/1')).toHaveLength(1));
    expect(bridge.callsTo('PATCH', '/api/v1/settings/vat/1')[0]!.body).toEqual({
      rateBp: 600,
      reason: 'تعديل القانون',
      rowVersion: 1,
    });
  });

  it('others see the VAT categories without the edit button', async () => {
    await signIn(signedInBridge(['items.manage']));
    await openLists();
    fireEvent.click(screen.getByRole('tab', { name: 'فئات الضريبة' }));
    expect(await screen.findByText('5%')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'تغيير نسبة SR' })).toBeNull();
    expect(screen.getByText(/لا يغيّر النسبة إلا المالك/)).toBeTruthy();
  });

  it('"Make default" sends the row version; the default cannot be deactivated', async () => {
    const bridge = signedInBridge(['warehouses.manage']);
    bridge.on('POST', '/api/v1/warehouses/2/make-default', ok({ warehouses: WAREHOUSES }));
    await signIn(bridge);
    await openLists();
    fireEvent.click(screen.getByRole('tab', { name: 'المستودعات' }));
    const main = await row('MAIN');
    expect(within(main).queryByRole('button', { name: 'إيقاف MAIN' })).toBeNull();
    expect(within(main).queryByRole('button', { name: /جعل MAIN/ })).toBeNull();

    fireEvent.click(
      within(await row('SITE-1')).getByRole('button', { name: 'جعل SITE-1 المستودع الافتراضي' }),
    );
    await waitFor(() =>
      expect(bridge.callsTo('POST', '/api/v1/warehouses/2/make-default')).toHaveLength(1),
    );
    expect(bridge.callsTo('POST', '/api/v1/warehouses/2/make-default')[0]!.body).toEqual({
      rowVersion: 3,
    });
  });

  it('deactivating a warehouse needs a reason and sends it with the row version', async () => {
    const bridge = signedInBridge(['warehouses.manage']);
    bridge.on('POST', '/api/v1/warehouses/2/deactivate', ok(WAREHOUSES[1]));
    await signIn(bridge);
    await openLists();
    fireEvent.click(screen.getByRole('tab', { name: 'المستودعات' }));
    fireEvent.click(within(await row('SITE-1')).getByRole('button', { name: 'إيقاف SITE-1' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^السبب/), {
      target: { value: 'انتهى المشروع' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إيقاف' }));
    await waitFor(() =>
      expect(bridge.callsTo('POST', '/api/v1/warehouses/2/deactivate')).toHaveLength(1),
    );
    expect(bridge.callsTo('POST', '/api/v1/warehouses/2/deactivate')[0]!.body).toEqual({
      reason: 'انتهى المشروع',
      rowVersion: 3,
    });
  });

  it('if someone else changed it first, deactivating closes and offers Reload', async () => {
    const bridge = signedInBridge(['warehouses.manage']);
    bridge.on('POST', '/api/v1/warehouses/2/deactivate', failure(409, 'STALE_VERSION'));
    await signIn(bridge);
    await openLists();
    fireEvent.click(screen.getByRole('tab', { name: 'المستودعات' }));
    fireEvent.click(within(await row('SITE-1')).getByRole('button', { name: 'إيقاف SITE-1' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^السبب/), {
      target: { value: 'انتهى المشروع' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إيقاف' }));
    await screen.findByText(/عدّل شخص آخر هذه البيانات/);
    expect(screen.queryByRole('dialog')).toBeNull();
    const reads = bridge.callsTo('GET', '/api/v1/warehouses').length;
    fireEvent.click(screen.getByRole('button', { name: 'إعادة التحميل' }));
    await waitFor(() =>
      expect(bridge.callsTo('GET', '/api/v1/warehouses').length).toBeGreaterThan(reads),
    );
  });

  it('a paid-out reason needs an account, chosen from accounts that receive postings', async () => {
    const bridge = signedInBridge(['system.settings.edit', 'ledger.view']);
    bridge.on('POST', '/api/v1/reason-codes', ok(reason({ id: '2' }), 201));
    await signIn(bridge);
    await openLists();
    fireEvent.click(screen.getByRole('tab', { name: 'رموز الأسباب' }));
    expect(await row('NS-CHANGE')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'سبب جديد' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^الكود/), { target: { value: 'PO-FUEL' } });
    fireEvent.change(within(dialog).getByLabelText(/^الاسم بالعربية/), {
      target: { value: 'وقود' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^الاسم بالإنجليزية/), {
      target: { value: 'Fuel' },
    });
    expect(within(dialog).queryByLabelText('الحساب')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('يُستخدم في'), {
      target: { value: 'paid_out' },
    });
    const accountField = within(dialog).getByLabelText('الحساب');
    // Headers, control accounts and deactivated accounts are not offered.
    expect(
      within(accountField)
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(['', '69']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(
      await within(dialog).findByText('المبالغ المودعة أو المصروفة تُسجَّل في حساب: اختر واحدًا.'),
    ).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/reason-codes')).toHaveLength(0);

    fireEvent.change(accountField, { target: { value: '69' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(bridge.callsTo('POST', '/api/v1/reason-codes')).toHaveLength(1));
    expect(bridge.callsTo('POST', '/api/v1/reason-codes')[0]!.body).toEqual({
      code: 'PO-FUEL',
      nameAr: 'وقود',
      nameEn: 'Fuel',
      category: 'paid_out',
      requiresNote: false,
      glAccountId: '69',
    });
  });

  it('a duplicate code is shown under the code field', async () => {
    const bridge = signedInBridge(['items.manage']);
    bridge.on(
      'POST',
      '/api/v1/units',
      ok({ error: { code: 'DUPLICATE', details: { field: 'code' } } }, 409),
    );
    await signIn(bridge);
    await openLists();
    fireEvent.click(await screen.findByRole('button', { name: 'وحدة جديدة' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^الكود/), { target: { value: 'PCS' } });
    fireEvent.change(within(dialog).getByLabelText(/^الاسم بالعربية/), {
      target: { value: 'قطعة' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^الاسم بالإنجليزية/), {
      target: { value: 'Piece' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByText('مستخدم في سجل آخر.')).toBeTruthy();
  });
});
