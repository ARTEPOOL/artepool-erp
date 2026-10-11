/**
 * T11: Settings → Company and Settings → VAT & numbering (design 13) against a scripted server:
 * the owner's company details and logo, the numbering series, and the accounting months
 * (decisions 0011, 0016, 0030, 0037). Runs in Arabic, the default language.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CompanyProfile, PeriodItem, SeriesItem } from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import {
  FakeBridge,
  failure,
  ok,
  sessionView,
  signInAnswer,
  userView,
} from '../support/fake-bridge';

const OWNER = [
  'users.view',
  'system.company.edit',
  'system.series.manage',
  'ledger.view',
  'periods.manage',
];
const ACCOUNTANT = ['ledger.view', 'periods.manage'];

const company = (patch: Partial<CompanyProfile> = {}): CompanyProfile => ({
  legalNameAr: 'أرتيبول لتجارة المسابح ذ.م.م',
  legalNameEn: 'ARTEPOOL Swimming Pools Trading LLC',
  tradeNameAr: null,
  tradeNameEn: null,
  vatRegistered: true,
  trn: '100123456789012',
  addressAr: 'العين، أبوظبي',
  addressEn: 'Al Ain, Abu Dhabi',
  city: 'العين',
  poBox: null,
  phone: '+97137654321',
  email: 'info@artepool.ae',
  website: null,
  emirate: 'abu_dhabi',
  logoType: null,
  currency: 'AED',
  rowVersion: 4,
  updatedAt: '2026-10-10T08:00:00.000Z',
  ...patch,
});

const series = (patch: Partial<SeriesItem>): SeriesItem => ({
  id: '1',
  code: 'POS',
  docType: 'invoice',
  channel: 'pos',
  prefix: 'POS-',
  numberWidth: 6,
  startNumber: '1',
  nextNumber: '125',
  used: true,
  nextFormatted: 'POS-000125',
  isActive: true,
  rowVersion: 2,
  ...patch,
});

const SERIES = [
  series({}),
  series({
    id: '3',
    code: 'CN',
    docType: 'credit_note',
    channel: null,
    prefix: 'CN-',
    nextNumber: '1',
    used: false,
    nextFormatted: 'CN-000001',
    rowVersion: 1,
  }),
];

const period = (start: string, patch: Partial<PeriodItem> = {}): PeriodItem => {
  const [y, m] = start.split('-').map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return {
    id: start.slice(0, 7).replace('-', ''),
    periodStart: start,
    periodEnd: end,
    fiscalYear: y,
    status: 'open',
    closedAt: null,
    closedByName: null,
    lockedAt: null,
    lockedByName: null,
    rowVersion: 3,
    ...patch,
  };
};

/** Newest first, as the server sends them; today is 11 October 2026. */
const PERIODS = [
  period('2027-01-01'),
  period('2026-12-01'),
  period('2026-11-01'),
  period('2026-10-01'),
  period('2026-09-01', { rowVersion: 5 }),
  period('2026-08-01', {
    status: 'closed',
    closedAt: '2026-09-03T06:00:00.000Z',
    closedByName: 'محمد ياسر',
    rowVersion: 7,
  }),
  period('2026-07-01', {
    status: 'locked',
    closedAt: '2026-08-03T06:00:00.000Z',
    closedByName: 'محمد ياسر',
    lockedAt: '2026-08-20T06:00:00.000Z',
    lockedByName: 'محمد ياسر',
  }),
];

function bridgeFor(permissions: string[], current: CompanyProfile | null = company()) {
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
    .on('GET', '/api/v1/company', ok({ company: current, canEdit: true }))
    .on('GET', '/api/v1/company/logo', ok({ logo: null }))
    .on('GET', '/api/v1/settings/series', ok({ series: SERIES }))
    .on('GET', '/api/v1/periods', ok({ periods: PERIODS, today: '2026-10-11' }))
    .on('GET', '/api/v1/settings/vat', ok({ categories: [], einvoiceMandatoryFrom: null }));
}

async function signIn(bridge: FakeBridge) {
  render(<App bridge={bridge} />);
  await screen.findByRole('heading', { level: 1 });
  fireEvent.change(screen.getByLabelText('اسم المستخدم'), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'blue-pool-water' } });
  fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
  await screen.findByRole('heading', { name: 'أهلًا، محمد ياسر' });
}

/** Opens Settings (it starts at the first section this person may open), then `section`. */
async function openSettings(first: string, section?: string) {
  fireEvent.click(screen.getByRole('link', { name: 'الإعدادات' }));
  await screen.findByRole('heading', { name: first, level: 2 });
  if (section) {
    const hub = screen.getByRole('navigation', { name: 'الإعدادات' });
    fireEvent.click(within(hub).getByRole('link', { name: section }));
    await screen.findByRole('heading', { name: section, level: 2 });
  }
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** The table row that shows `text` (waits for the list to load). */
async function rowOf(text: string): Promise<HTMLElement> {
  return (await screen.findByText(text, { selector: 'td, td b, td bdi' })).closest('tr')!;
}

describe('Settings → Company (owner only)', () => {
  it('the first save creates the record: no version is sent, and the TRN goes as typed', async () => {
    const saved = company({ rowVersion: 1 });
    const bridge = bridgeFor(OWNER, null).on('PUT', '/api/v1/company', ok(saved));
    bridge.on(
      'GET',
      '/api/v1/company',
      ok({ company: null, canEdit: true }),
      ok({ company: saved, canEdit: true }),
    );
    await signIn(bridge);
    await openSettings('الشركة');
    expect(await screen.findByText(/لم تُحفظ بيانات الشركة بعد/)).toBeTruthy();
    // The logo waits for the details to exist.
    expect(screen.getByText('احفظ بيانات الشركة أولًا، ثم ارفع الشعار.')).toBeTruthy();

    type('الاسم القانوني بالعربية *', 'أرتيبول لتجارة المسابح ذ.م.م');
    type('الاسم القانوني بالإنجليزية *', 'ARTEPOOL Swimming Pools Trading LLC');
    type('العنوان بالعربية *', 'العين، أبوظبي');
    type('العنوان بالإنجليزية *', 'Al Ain, Abu Dhabi');
    fireEvent.click(screen.getByRole('switch', { name: 'مسجّلة في ضريبة القيمة المضافة' }));
    type('الرقم الضريبي (TRN)', '100 123 456 789 012');
    fireEvent.change(screen.getByLabelText('الإمارة'), { target: { value: 'abu_dhabi' } });
    expect(screen.getByText('تعديلات غير محفوظة')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ التغييرات' }));

    expect(await screen.findByText('تم الحفظ.')).toBeTruthy();
    const call = bridge.callsTo('PUT', '/api/v1/company')[0]!;
    expect(call.body).not.toHaveProperty('rowVersion');
    expect(call.body).toMatchObject({
      legalNameAr: 'أرتيبول لتجارة المسابح ذ.م.م',
      legalNameEn: 'ARTEPOOL Swimming Pools Trading LLC',
      vatRegistered: true,
      trn: '100 123 456 789 012',
      addressAr: 'العين، أبوظبي',
      addressEn: 'Al Ain, Abu Dhabi',
      emirate: 'abu_dhabi',
    });
    expect(call.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.queryByText('تعديلات غير محفوظة')).toBeNull());
  });

  it('a VAT-registered company without a valid TRN shows the field message and sends nothing', async () => {
    const bridge = bridgeFor(OWNER);
    await signIn(bridge);
    await openSettings('الشركة');
    await screen.findByDisplayValue('100123456789012');
    type('الرقم الضريبي (TRN)', '200123456789012');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ التغييرات' }));
    expect(await screen.findByText('الرقم الضريبي 15 رقمًا يبدأ بـ 100.')).toBeTruthy();
    type('الاسم القانوني بالعربية *', ' ');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ التغييرات' }));
    expect(await screen.findByText('إلزامي.')).toBeTruthy();
    expect(bridge.callsTo('PUT', '/api/v1/company')).toHaveLength(0);
  });

  it('someone else saved in between: "changed by someone else" with a Reload button', async () => {
    const theirs = company({ legalNameEn: 'ARTEPOOL LLC', rowVersion: 5 });
    const bridge = bridgeFor(OWNER)
      .on('PUT', '/api/v1/company', failure(409, 'STALE_VERSION'))
      .on(
        'GET',
        '/api/v1/company',
        ok({ company: company(), canEdit: true }),
        ok({ company: theirs, canEdit: true }),
      );
    await signIn(bridge);
    await openSettings('الشركة');
    await screen.findByDisplayValue('ARTEPOOL Swimming Pools Trading LLC');
    type('المدينة', 'العين الجديدة');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ التغييرات' }));
    expect(await screen.findByText(/عدّل شخص آخر هذه البيانات أثناء تعديلك لها/)).toBeTruthy();
    expect(bridge.callsTo('PUT', '/api/v1/company')[0]?.body).toMatchObject({
      city: 'العين الجديدة',
      rowVersion: 4,
    });

    fireEvent.click(screen.getByRole('button', { name: 'إعادة التحميل' }));
    expect(await screen.findByDisplayValue('ARTEPOOL LLC')).toBeTruthy();
    expect(screen.queryByText(/عدّل شخص آخر/)).toBeNull();
    expect(screen.queryByText('تعديلات غير محفوظة')).toBeNull();
  });

  it('a logo that is SVG or larger than 512 KB is refused before anything is sent', async () => {
    const bridge = bridgeFor(OWNER).on(
      'PUT',
      '/api/v1/company/logo',
      ok(company({ logoType: 'image/png' })),
    );
    await signIn(bridge);
    await openSettings('الشركة');
    const input = await screen.findByLabelText('رفع شعار جديد', { selector: 'input' });
    expect(screen.getByText(/PNG أو JPEG بحجم 512 كيلوبايت كحد أقصى/)).toBeTruthy();

    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', {
      type: 'image/svg+xml',
    });
    fireEvent.change(input, { target: { files: [svg] } });
    expect(await screen.findByText(/اختر صورة PNG أو JPEG/)).toBeTruthy();

    const big = new File([new Uint8Array(512 * 1024 + 1)], 'big.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText(/حجم الشعار أكبر من 512 كيلوبايت/)).toBeTruthy();
    expect(bridge.callsTo('PUT', '/api/v1/company/logo')).toHaveLength(0);

    const png = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      'logo.png',
      {
        type: 'image/png',
      },
    );
    fireEvent.change(input, { target: { files: [png] } });
    await waitFor(() => expect(bridge.callsTo('PUT', '/api/v1/company/logo')).toHaveLength(1));
    expect(bridge.callsTo('PUT', '/api/v1/company/logo')[0]?.body).toEqual({
      logo: { type: 'image/png', dataBase64: 'iVBORw0KGgo=' },
      rowVersion: 4,
    });
  });

  it('shows the fixed general settings with a "Locked" chip', async () => {
    await signIn(bridgeFor(OWNER));
    await openSettings('الشركة');
    expect(await screen.findByText('Asia/Dubai')).toBeTruthy();
    expect(screen.getByText('AED')).toBeTruthy();
    expect(screen.getByText('يناير – ديسمبر')).toBeTruthy();
    expect(screen.getAllByText('مقفل')).toHaveLength(3);
  });
});

describe('Settings → VAT & numbering', () => {
  it('a series that already issued numbers cannot be edited; an unused one can', async () => {
    const bridge = bridgeFor(OWNER).on(
      'PATCH',
      '/api/v1/settings/series/3',
      ok(series({ id: '3', prefix: 'CR-' })),
    );
    await signIn(bridge);
    await openSettings('الشركة', 'الضريبة والترقيم');
    const pos = await rowOf('فاتورة نقطة البيع');
    expect(within(pos).getByText('POS-000125')).toBeTruthy();
    expect(within(pos).getByText('مستخدم')).toBeTruthy();
    expect(within(pos).getByText('ثابت: صدرت منه أرقام')).toBeTruthy();
    expect(within(pos).queryByRole('button')).toBeNull();

    const credit = await rowOf('إشعار دائن');
    fireEvent.click(within(credit).getByRole('button', { name: 'تعديل ترقيم إشعار دائن' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('البادئة'), { target: { value: 'cr-' } });
    fireEvent.change(within(dialog).getByLabelText('عدد الخانات'), { target: { value: '13' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByText('اكتب رقمًا من 1 إلى 12.')).toBeTruthy();
    expect(bridge.callsTo('PATCH', '/api/v1/settings/series/3')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText('عدد الخانات'), { target: { value: '5' } });
    expect(within(dialog).getByText('CR-00001')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.callsTo('PATCH', '/api/v1/settings/series/3')[0]?.body).toEqual({
      prefix: 'CR-',
      numberWidth: 5,
      startNumber: '1',
      rowVersion: 1,
    });
  });

  it('e-invoicing waits for the accountant; VAT categories are in Lists', async () => {
    await signIn(bridgeFor(OWNER));
    await openSettings('الشركة', 'الضريبة والترقيم');
    expect(await screen.findByText('لم يُحدَّد — بانتظار المحاسب')).toBeTruthy();
    expect(screen.getByText('لكل سطر، ثم جمع الأسطر')).toBeTruthy();
    expect(screen.getByText(/فئات الضريبة ونسبها موجودة في الإعدادات ← القوائم/)).toBeTruthy();
  });

  it('closing an ended month sends its version; a month that has not ended cannot be closed', async () => {
    const bridge = bridgeFor(OWNER).on(
      'POST',
      '/api/v1/periods/202609/close',
      ok(period('2026-09-01', { status: 'closed', rowVersion: 6 })),
    );
    await signIn(bridge);
    await openSettings('الشركة', 'الضريبة والترقيم');
    const october = await screen.findByRole('button', { name: 'إقفال أكتوبر 2026' });
    expect(october.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('يمكن إقفاله بعد 2026-10-31')).toBeTruthy();
    expect(within(await rowOf('يوليو 2026')).getByText('مقفلة نهائيًا')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'إقفال سبتمبر 2026' }));
    expect(await screen.findByText('أُقفل سبتمبر 2026.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/periods/202609/close')[0]?.body).toEqual({
      rowVersion: 5,
    });
    expect(bridge.callsTo('POST', '/api/v1/periods/202610/close')).toHaveLength(0);
  });

  it('reopening a closed month needs a reason', async () => {
    const bridge = bridgeFor(OWNER).on(
      'POST',
      '/api/v1/periods/202608/reopen',
      ok(period('2026-08-01', { rowVersion: 8 })),
    );
    await signIn(bridge);
    await openSettings('الشركة', 'الضريبة والترقيم');
    fireEvent.click(await screen.findByRole('button', { name: 'إعادة فتح أغسطس 2026' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'إعادة فتح' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('السبب (إلزامي)'), { target: { value: 'خط' } });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(bridge.callsTo('POST', '/api/v1/periods/202608/reopen')).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText('السبب (إلزامي)'), {
      target: { value: 'فاتورة مورد متأخرة' },
    });
    fireEvent.click(confirm);
    expect(await screen.findByText('أُعيد فتح أغسطس 2026.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/periods/202608/reopen')[0]?.body).toEqual({
      reason: 'فاتورة مورد متأخرة',
      rowVersion: 7,
    });
  });

  it('locking asks for confirmation with a clear warning that it is permanent', async () => {
    const bridge = bridgeFor(OWNER).on(
      'POST',
      '/api/v1/periods/202608/lock',
      ok(period('2026-08-01', { status: 'locked', rowVersion: 8 })),
    );
    await signIn(bridge);
    await openSettings('الشركة', 'الضريبة والترقيم');
    fireEvent.click(await screen.findByRole('button', { name: 'قفل أغسطس 2026 نهائيًا' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/لا يمكن إعادة فتحه أبدًا/)).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/periods/202608/lock')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.callsTo('POST', '/api/v1/periods/202608/lock')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'قفل أغسطس 2026 نهائيًا' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'قفل نهائي' }),
    );
    expect(await screen.findByText('قُفل أغسطس 2026 نهائيًا.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/periods/202608/lock')[0]?.body).toEqual({
      rowVersion: 7,
    });
  });

  it('shows the most recent 15 months, then all of them on request', async () => {
    const many = Array.from({ length: 20 }, (_, i) => {
      const at = new Date(Date.UTC(2027, 0 - i, 1)).toISOString().slice(0, 10);
      return period(at);
    });
    const bridge = bridgeFor(OWNER).on(
      'GET',
      '/api/v1/periods',
      ok({ periods: many, today: '2026-10-11' }),
    );
    await signIn(bridge);
    await openSettings('الشركة', 'الضريبة والترقيم');
    await screen.findByText('يناير 2027');
    expect(screen.queryByText('يونيو 2025')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'عرض الكل (20)' }));
    expect(await screen.findByText('يونيو 2025')).toBeTruthy();
  });
});

describe('the accountant', () => {
  it('does not see Company; sees the accounting months but not the numbering', async () => {
    const bridge = bridgeFor(ACCOUNTANT);
    await signIn(bridge);
    await openSettings('الضريبة والترقيم');
    const hub = screen.getByRole('navigation', { name: 'الإعدادات' });
    expect(within(hub).queryByRole('link', { name: 'الشركة' })).toBeNull();
    expect(await screen.findByRole('heading', { name: 'الفترات المحاسبية' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'إقفال سبتمبر 2026' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'ترقيم المستندات' })).toBeNull();
    expect(bridge.callsTo('GET', '/api/v1/settings/series')).toHaveLength(0);
    expect(bridge.callsTo('PUT', '/api/v1/company')).toHaveLength(0);
  });
});
