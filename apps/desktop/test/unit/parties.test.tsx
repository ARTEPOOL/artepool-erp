/**
 * T10: Customers (design 14) and Suppliers against a scripted server: a cashier adds customers
 * (always as cash), VAT-registered needs a valid TRN, a duplicate phone is shown under the phone,
 * the accountant gives credit with a reason, the walk-in customer is locked, someone else's save
 * is reloaded, and suppliers are listed and added.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  CustomerDetail,
  CustomerListItem,
  CustomersResponse,
  SupplierDetail,
  SuppliersResponse,
} from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { setLanguage } from '../../src/i18n';
import {
  failure,
  FakeBridge,
  ok,
  sessionView,
  signInAnswer,
  userView,
} from '../support/fake-bridge';

const CASHIER = ['customers.view', 'customers.manage'];
const ACCOUNTANT = ['customers.view', 'customers.manage', 'customers.credit', 'data.export'];

const customer = (patch: Partial<CustomerDetail> = {}): CustomerDetail => ({
  id: '12',
  code: 'C00012',
  customerType: 'company',
  name: 'فندق الواحة',
  nameAlt: 'Al Waha Hotel',
  phone: '+97137654321',
  isVatRegistered: true,
  trn: '100456789000003',
  creditMode: 'cash',
  isWalkIn: false,
  isActive: true,
  phoneAlt: null,
  email: 'finance@alwaha.example',
  addressLine: 'شارع خليفة',
  area: null,
  city: 'العين',
  poBox: null,
  emirate: 'abu_dhabi',
  countryCode: 'AE',
  paymentTermsDays: 0,
  creditLimitFils: '0',
  preferredLanguage: null,
  notes: null,
  rowVersion: 3,
  ...patch,
});

const WALK_IN = customer({
  id: '1',
  code: 'WALKIN',
  customerType: 'individual',
  name: 'عميل نقدي',
  nameAlt: 'Cash customer',
  phone: null,
  isVatRegistered: false,
  trn: null,
  isWalkIn: true,
  email: null,
  addressLine: null,
  city: null,
  emirate: null,
  rowVersion: 1,
});

const listItem = (c: CustomerDetail): CustomerListItem => ({
  id: c.id,
  code: c.code,
  customerType: c.customerType,
  name: c.name,
  nameAlt: c.nameAlt,
  phone: c.phone,
  isVatRegistered: c.isVatRegistered,
  trn: c.trn,
  creditMode: c.creditMode,
  isWalkIn: c.isWalkIn,
  isActive: c.isActive,
});

const customersAnswer = (list: CustomerDetail[]): CustomersResponse => ({
  customers: list.map(listItem),
  total: list.length,
  counts: { active: list.length, vatRegistered: list.filter((c) => c.isVatRegistered).length },
});

const supplier = (patch: Partial<SupplierDetail> = {}): SupplierDetail => ({
  id: '4',
  code: 'S00004',
  name: 'شركة الخليج للكيماويات',
  nameAlt: 'Gulf Chemicals',
  phone: '+97142345678',
  isVatRegistered: true,
  trn: '100567812300003',
  isActive: true,
  email: null,
  addressLine: null,
  city: 'دبي',
  emirate: 'dubai',
  countryCode: 'AE',
  paymentTermsDays: 30,
  notes: null,
  rowVersion: 2,
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
    .on('GET', '/api/v1/customers', ok(customersAnswer([WALK_IN, customer()])))
    .on('GET', '/api/v1/customers/12', ok(customer()))
    .on('GET', '/api/v1/customers/1', ok(WALK_IN));
}

async function signIn(bridge: FakeBridge) {
  render(<App bridge={bridge} />);
  await screen.findByRole('heading', { level: 1 });
  fireEvent.change(screen.getByLabelText('اسم المستخدم'), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'blue-pool-water' } });
  fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
  await screen.findByRole('heading', { name: 'أهلًا، محمد ياسر' });
}

async function openPage(link: string) {
  fireEvent.click(screen.getByRole('link', { name: link }));
  await screen.findByRole('heading', { name: link, level: 1 });
}

/** The table row whose bold title is `name` (waits for the list to load). */
async function row(name: string): Promise<HTMLElement> {
  const title = await screen.findByText(name, { selector: 'tbody b' });
  return title.closest('tr')!;
}

/** The selected record's details (the panel beside the list). */
async function detailPanel(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name, level: 2 });
  return heading.closest('aside')!;
}

async function openNewCustomer(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'عميل جديد' }));
  return screen.findByRole('dialog');
}

function fill(dialog: HTMLElement, label: string, value: string) {
  fireEvent.change(within(dialog).getByLabelText(label, { exact: true }), { target: { value } });
}

function fillNewCustomer(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: 'فرد' }));
  fill(dialog, 'الاسم', 'خالد النعيمي');
  fill(dialog, 'الهاتف', '050 123 4567');
}

const NEW_CUSTOMER = customer({
  id: '30',
  code: 'C00030',
  customerType: 'individual',
  name: 'خالد النعيمي',
  nameAlt: null,
  phone: '+971501234567',
  isVatRegistered: false,
  trn: null,
  email: null,
  addressLine: null,
  city: null,
  emirate: null,
  rowVersion: 1,
});

describe('Customers', () => {
  it('lists customers with their type, VAT invoice and cash/credit; the counts on top', async () => {
    await signIn(signedInBridge(CASHIER));
    await openPage('العملاء');
    const hotel = await row('فندق الواحة');
    expect(within(hotel).getByText('شركة')).toBeTruthy();
    expect(within(hotel).getByText('فاتورة كاملة')).toBeTruthy();
    expect(within(hotel).getByText('TRN 100456789000003')).toBeTruthy();
    expect(within(hotel).getByText('03 765 4321')).toBeTruthy();
    expect(within(hotel).getByText('نقدي')).toBeTruthy();
    expect(within(await row('عميل نقدي')).getByText('فاتورة مبسطة')).toBeTruthy();
    // The first real customer is shown beside the list.
    const panel = await detailPanel('فندق الواحة');
    expect(within(panel).getByText('فاتورة ضريبية كاملة')).toBeTruthy();
    expect(within(panel).getByText('أبوظبي')).toBeTruthy();
    expect(screen.getByText('العملاء النشطون')).toBeTruthy();
    // Balance parts arrive in M4: not shown.
    expect(screen.queryByText('الرصيد')).toBeNull();
  });

  it('a cashier adds a customer, always as cash, and cannot change credit', async () => {
    const bridge = signedInBridge(CASHIER)
      .on('POST', '/api/v1/customers', ok(NEW_CUSTOMER, 201))
      .on('GET', '/api/v1/customers/30', ok(NEW_CUSTOMER));
    await signIn(bridge);
    await openPage('العملاء');
    const dialog = await openNewCustomer();
    expect(within(dialog).getByText(/يبدأ كل عميل جديد نقدًا/)).toBeTruthy();
    fillNewCustomer(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ العميل' }));

    const panel = await detailPanel('خالد النعيمي');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const call = bridge.callsTo('POST', '/api/v1/customers')[0]!;
    expect(call.body).toEqual({
      customerType: 'individual',
      name: 'خالد النعيمي',
      nameAlt: null,
      phone: '050 123 4567',
      phoneAlt: null,
      email: null,
      addressLine: null,
      area: null,
      city: null,
      poBox: null,
      emirate: null,
      isVatRegistered: false,
      trn: null,
      preferredLanguage: null,
      notes: null,
    });
    expect(call.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(within(panel).getByText('050 123 4567')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'تعديل' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'تغيير الائتمان' })).toBeNull();
  });

  it('the customer type is required', async () => {
    const bridge = signedInBridge(CASHIER);
    await signIn(bridge);
    await openPage('العملاء');
    const dialog = await openNewCustomer();
    fill(dialog, 'الاسم', 'خالد النعيمي');
    fill(dialog, 'الهاتف', '050 123 4567');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ العميل' }));
    expect(await within(dialog).findByText('اختر نوع العميل.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/customers')).toHaveLength(0);
  });

  it('VAT-registered needs a valid TRN before anything is sent', async () => {
    const bridge = signedInBridge(CASHIER)
      .on('POST', '/api/v1/customers', ok(NEW_CUSTOMER, 201))
      .on('GET', '/api/v1/customers/30', ok(NEW_CUSTOMER));
    await signIn(bridge);
    await openPage('العملاء');
    const dialog = await openNewCustomer();
    fillNewCustomer(dialog);
    expect(within(dialog).getByText('ستصدر له فاتورة ضريبية مبسطة')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('switch', { name: /مسجل في ضريبة القيمة المضافة/ }));
    expect(within(dialog).getByText('ستصدر له فاتورة ضريبية كاملة برقمه الضريبي')).toBeTruthy();

    fill(dialog, 'الرقم الضريبي (15 رقمًا)', '200123');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ العميل' }));
    const trnInput = within(dialog).getByLabelText('الرقم الضريبي (15 رقمًا)', { exact: true });
    expect(
      await within(trnInput.parentElement!).findByText('الرقم الضريبي 15 رقمًا يبدأ بـ 100.'),
    ).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/customers')).toHaveLength(0);

    fill(dialog, 'الرقم الضريبي (15 رقمًا)', '100 2345 6780 0003');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ العميل' }));
    await waitFor(() => expect(bridge.callsTo('POST', '/api/v1/customers')).toHaveLength(1));
    expect(bridge.callsTo('POST', '/api/v1/customers')[0]!.body).toMatchObject({
      isVatRegistered: true,
      trn: '100 2345 6780 0003',
    });
  });

  it('a phone already used by another customer is shown under the phone field', async () => {
    const bridge = signedInBridge(CASHIER).on(
      'POST',
      '/api/v1/customers',
      failure(409, 'DUPLICATE', { field: 'phone' }),
    );
    await signIn(bridge);
    await openPage('العملاء');
    const dialog = await openNewCustomer();
    fillNewCustomer(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ العميل' }));
    const phone = within(dialog).getByLabelText('الهاتف', { exact: true });
    expect(await within(phone.parentElement!).findByText('مستخدم في سجل آخر.')).toBeTruthy();
    expect(phone.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('the accountant gives credit with a reason; the amount is sent as whole fils', async () => {
    const bridge = signedInBridge(ACCOUNTANT).on(
      'POST',
      '/api/v1/customers/12/credit',
      ok(customer({ creditMode: 'credit', creditLimitFils: '500000', paymentTermsDays: 30 })),
    );
    await signIn(bridge);
    await openPage('العملاء');
    const panel = await detailPanel('فندق الواحة');
    fireEvent.click(within(panel).getByRole('button', { name: 'تغيير الائتمان' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'آجل' }));
    fill(dialog, 'حد الائتمان (درهم)', '5000');
    fireEvent.change(within(dialog).getByLabelText('شروط الدفع'), { target: { value: '30' } });

    // The reason is required.
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الائتمان' }));
    expect(await within(dialog).findByText('اكتب سببًا من 3 أحرف على الأقل.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/customers/12/credit')).toHaveLength(0);

    fill(dialog, 'السبب (إلزامي)', 'عميل قديم موثوق');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الائتمان' }));
    expect(await screen.findByText('حُفظ ائتمان العميل.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/customers/12/credit')[0]!.body).toEqual({
      credit: { mode: 'credit', creditLimitFils: '500000', paymentTermsDays: 30 },
      reason: 'عميل قديم موثوق',
      rowVersion: 3,
    });
  });

  it('a credit limit that is not a valid amount is refused on this PC', async () => {
    const bridge = signedInBridge(ACCOUNTANT);
    await signIn(bridge);
    await openPage('العملاء');
    const panel = await detailPanel('فندق الواحة');
    fireEvent.click(within(panel).getByRole('button', { name: 'تغيير الائتمان' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'آجل' }));
    fill(dialog, 'حد الائتمان (درهم)', '12.345');
    fill(dialog, 'السبب (إلزامي)', 'عميل قديم موثوق');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ الائتمان' }));
    expect(
      await within(dialog).findByText('اكتب مبلغًا صحيحًا، مثل 5000 أو 5000.50.'),
    ).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/customers/12/credit')).toHaveLength(0);
  });

  it('the walk-in customer is shown locked: no Edit, Deactivate or credit', async () => {
    await signIn(signedInBridge(ACCOUNTANT));
    await openPage('العملاء');
    fireEvent.click(await row('عميل نقدي'));
    const panel = await detailPanel('عميل نقدي');
    expect(within(panel).getByText(/لا يُعدَّل ولا يُوقف/)).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'تعديل' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'إيقاف العميل' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'تغيير الائتمان' })).toBeNull();
  });

  it('deactivating needs a reason and sends the row version', async () => {
    const bridge = signedInBridge(CASHIER).on(
      'POST',
      '/api/v1/customers/12/deactivate',
      ok(customer({ isActive: false, rowVersion: 4 })),
    );
    await signIn(bridge);
    await openPage('العملاء');
    const panel = await detailPanel('فندق الواحة');
    fireEvent.click(within(panel).getByRole('button', { name: 'إيقاف العميل' }));
    const dialog = await screen.findByRole('dialog');
    fill(dialog, 'السبب (إلزامي)', 'أغلق نشاطه');
    fireEvent.click(within(dialog).getByRole('button', { name: 'إيقاف' }));
    expect(await screen.findByText('تم الإيقاف.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/customers/12/deactivate')[0]!.body).toEqual({
      reason: 'أغلق نشاطه',
      rowVersion: 3,
    });
  });

  it('when someone else saved first, Reload brings their changes into the form', async () => {
    let current = customer();
    const bridge = signedInBridge(CASHIER)
      .on('GET', '/api/v1/customers/12', () => ok(current))
      .on(
        'PUT',
        '/api/v1/customers/12',
        failure(409, 'STALE_VERSION', { currentVersion: 4 }),
        ok(customer({ rowVersion: 5 })),
      );
    await signIn(bridge);
    await openPage('العملاء');
    const panel = await detailPanel('فندق الواحة');
    fireEvent.click(within(panel).getByRole('button', { name: 'تعديل' }));
    const dialog = await screen.findByRole('dialog');
    fill(dialog, 'المدينة', 'دبي');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ العميل' }));
    expect(await within(dialog).findByText(/عدّل شخص آخر هذه البيانات/)).toBeTruthy();
    expect(bridge.callsTo('PUT', '/api/v1/customers/12')[0]!.body).toMatchObject({
      city: 'دبي',
      rowVersion: 3,
    });

    current = customer({ city: 'الشارقة', rowVersion: 4 });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إعادة التحميل' }));
    await waitFor(() =>
      expect(
        within(dialog).getByLabelText<HTMLInputElement>('المدينة', { exact: true }).value,
      ).toBe('الشارقة'),
    );
    expect(within(dialog).queryByText(/عدّل شخص آخر هذه البيانات/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ العميل' }));
    await waitFor(() => expect(bridge.callsTo('PUT', '/api/v1/customers/12')).toHaveLength(2));
    expect(bridge.callsTo('PUT', '/api/v1/customers/12')[1]!.body).toMatchObject({
      city: 'الشارقة',
      rowVersion: 4,
    });
  });
});

describe('Customers in English', () => {
  it('works the same in English, left to right', async () => {
    await act(() => setLanguage('en'));
    const credit = customer({
      creditMode: 'credit',
      creditLimitFils: '500000',
      paymentTermsDays: 30,
    });
    const bridge = signedInBridge(ACCOUNTANT)
      .on('GET', '/api/v1/customers', ok(customersAnswer([WALK_IN, credit])))
      .on('GET', '/api/v1/customers/12', ok(credit));
    render(<App bridge={bridge} />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'mohammed' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'blue-pool-water' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Customers' }));
    await screen.findByRole('heading', { name: 'Customers', level: 1 });
    expect(document.documentElement.dir).toBe('ltr');
    const hotel = await row('فندق الواحة');
    expect(within(hotel).getByText('Company')).toBeTruthy();
    expect(within(hotel).getByText('Full tax invoice')).toBeTruthy();
    expect(within(hotel).getByText('Credit')).toBeTruthy();
    const panel = await detailPanel('فندق الواحة');
    expect(within(panel).getByText('5,000.00')).toBeTruthy();
    expect(within(panel).getByText('30 days')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Change credit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export Excel' })).toBeTruthy();
  });
});

describe('Suppliers', () => {
  const suppliersAnswer = (list: SupplierDetail[]): SuppliersResponse => ({
    suppliers: list.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      nameAlt: s.nameAlt,
      phone: s.phone,
      isVatRegistered: s.isVatRegistered,
      trn: s.trn,
      isActive: s.isActive,
    })),
    total: list.length,
  });

  it('lists suppliers and adds one', async () => {
    const created = supplier({
      id: '9',
      code: 'S00009',
      name: 'مؤسسة الواحة للمضخات',
      nameAlt: null,
      phone: '+97137654321',
      isVatRegistered: false,
      trn: null,
      city: null,
      emirate: null,
      paymentTermsDays: 30,
      rowVersion: 1,
    });
    const bridge = signedInBridge(['suppliers.manage'])
      .on('GET', '/api/v1/suppliers', ok(suppliersAnswer([supplier()])))
      .on('GET', '/api/v1/suppliers/4', ok(supplier()))
      .on('GET', '/api/v1/suppliers/9', ok(created))
      .on('POST', '/api/v1/suppliers', ok(created, 201));
    await signIn(bridge);
    expect(screen.queryByRole('link', { name: 'العملاء' })).toBeNull();
    await openPage('الموردون');
    const gulf = await row('شركة الخليج للكيماويات');
    expect(within(gulf).getByText('TRN 100567812300003')).toBeTruthy();
    expect(within(gulf).getByText('04 234 5678')).toBeTruthy();
    const panel = await detailPanel('شركة الخليج للكيماويات');
    expect(within(panel).getByText('30 يومًا')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'مورد جديد' }));
    const dialog = await screen.findByRole('dialog');
    fill(dialog, 'الاسم', 'مؤسسة الواحة للمضخات');
    fill(dialog, 'الهاتف', '03 765 4321');
    fill(dialog, 'شروط الدفع (أيام)', '30');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ المورد' }));
    await detailPanel('مؤسسة الواحة للمضخات');
    expect(bridge.callsTo('POST', '/api/v1/suppliers')[0]!.body).toEqual({
      name: 'مؤسسة الواحة للمضخات',
      nameAlt: null,
      phone: '03 765 4321',
      email: null,
      addressLine: null,
      city: null,
      emirate: null,
      countryCode: 'AE',
      isVatRegistered: false,
      trn: null,
      paymentTermsDays: 30,
      notes: null,
    });
  });

  it('a supplier TRN must be valid before anything is sent', async () => {
    const bridge = signedInBridge(['suppliers.manage'])
      .on('GET', '/api/v1/suppliers', ok(suppliersAnswer([])))
      .on('POST', '/api/v1/suppliers', ok(supplier(), 201));
    await signIn(bridge);
    await openPage('الموردون');
    expect(await screen.findByText('لا يوجد موردون مطابقون.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'مورد جديد' }));
    const dialog = await screen.findByRole('dialog');
    fill(dialog, 'الاسم', 'شركة الخليج للكيماويات');
    fireEvent.click(within(dialog).getByRole('switch', { name: /مسجل في ضريبة القيمة المضافة/ }));
    fill(dialog, 'الرقم الضريبي (15 رقمًا)', '1005678123');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ المورد' }));
    expect(await within(dialog).findByText('الرقم الضريبي 15 رقمًا يبدأ بـ 100.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/suppliers')).toHaveLength(0);
  });
});
