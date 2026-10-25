/**
 * Settings → Print designer → Barcode label (decision 0097), against a scripted server: the
 * previews show every active size and say when the design will not fit one; a per-size override
 * (the English name hidden on 40 × 30) is saved with the version it started from; the barcode
 * height never goes below 5 mm; "Reset to default design" brings the default back.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LabelDesignResponse, LabelSizeItem } from '@artepool/shared/contracts';
import { defaultLabelDesign } from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { FakeBridge, ok, sessionView, signInAnswer, userView } from '../support/fake-bridge';

const size = (patch: Partial<LabelSizeItem>): LabelSizeItem => ({
  id: '1',
  code: '50x30',
  nameAr: 'أساسي',
  nameEn: 'Standard',
  widthMm: 50,
  heightMm: 30,
  sortOrder: 1,
  isActive: true,
  rowVersion: 1,
  ...patch,
});

const SIZES = [
  size({}),
  size({ id: '2', code: '40x30', nameAr: 'صغير', nameEn: 'Small', widthMm: 40, sortOrder: 2 }),
  // Far too small for any design: the preview says so instead of drawing a broken label.
  size({ id: '3', code: '25x10', nameAr: 'صغير جدًا', nameEn: 'Tiny', widthMm: 25, heightMm: 10 }),
  size({ id: '4', code: 'old', nameAr: 'قديم', nameEn: 'Old', isActive: false, sortOrder: 4 }),
];

const SAVED: LabelDesignResponse = {
  versionId: '9',
  versionNo: 3,
  savedAt: '2026-10-20T08:00:00.000Z',
  savedBy: { displayNameAr: 'محمد ياسر', displayNameEn: 'Mohammed Yasser' },
  design: defaultLabelDesign(),
  shopName: { ar: 'آرتيبول', en: 'ARTEPOOL' },
  canEdit: true,
};

function bridge() {
  return new FakeBridge()
    .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer({}, { displayNameAr: 'محمد ياسر' })))
    .on(
      'GET',
      '/api/v1/auth/me',
      ok({
        session: sessionView(),
        user: userView({ displayNameAr: 'محمد ياسر', displayNameEn: 'Mohammed Yasser' }),
        device: { id: '2', code: 'OFFICE-01', name: 'Owner office', kind: 'office' },
        permissions: ['print_templates.manage', 'labels.print'],
      }),
    )
    .on('GET', '/api/v1/print-templates', ok({ templates: [], bankAccounts: [] }))
    .on('GET', '/api/v1/label-sizes', ok({ labelSizes: SIZES, maxWidthMm: 50 }))
    .on('GET', '/api/v1/label-design', ok(SAVED))
    .on('GET', '/api/v1/units', ok({ units: [] }))
    .on('GET', '/api/v1/items', ok({ items: [], total: 0, counts: {}, exactMatchId: null }))
    .on('POST', '/api/v1/label-design/versions', (request) =>
      ok({
        ...SAVED,
        versionId: '10',
        versionNo: 4,
        design: (request.body as { design: unknown }).design,
      }),
    );
}

async function openDesigner(fake: FakeBridge) {
  render(<App bridge={fake} />);
  await screen.findByRole('heading', { level: 1 });
  fireEvent.change(screen.getByLabelText('اسم المستخدم'), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'blue-pool-water' } });
  fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
  await screen.findByRole('heading', { name: 'أهلًا، محمد ياسر' });
  fireEvent.click(screen.getByRole('link', { name: 'الإعدادات' }));
  fireEvent.click(await screen.findByRole('link', { name: 'تصميم المطبوعات' }));
  fireEvent.click(await screen.findByRole('tab', { name: 'ملصق الباركود' }));
  await screen.findByTestId('label-design-preview-50x30');
}

const preview = (code: string) => screen.getByTestId(`label-design-preview-${code}`);

describe('Settings → Print designer → Barcode label', () => {
  it('previews every active size, and says plainly when the design will not fit one', async () => {
    await openDesigner(bridge());
    expect(screen.getByText(/الإصدار 3/)).toBeTruthy();
    expect(within(preview('50x30')).getByRole('img', { name: 'ملصق 50 × 30 زي ما هيتطبع' }));
    expect(within(preview('40x30')).getByRole('img', { name: 'ملصق 40 × 30 زي ما هيتطبع' }));
    // No label is drawn for a size the design does not fit: a warning instead.
    const tiny = preview('25x10');
    expect(within(tiny).getByText('مش هيدخل في 25 × 10')).toBeTruthy();
    expect(within(tiny).queryByRole('img')).toBeNull();
    expect(screen.queryByTestId('label-design-preview-old')).toBeNull();
    // Nothing changed yet: nothing to save.
    expect(screen.getByRole('button', { name: 'حفظ' }).hasAttribute('disabled')).toBe(true);
  });

  it('the English name on every size but 40 × 30: saved as a per-size override', async () => {
    const fake = bridge();
    await openDesigner(fake);
    const nameEn = screen.getByTestId('label-element-nameEn');
    fireEvent.click(within(nameEn).getByRole('switch', { name: 'الاسم الإنجليزي' }));
    expect(screen.getByText('غير محفوظ')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('المقاس'), { target: { value: '40x30' } });
    fireEvent.change(screen.getByLabelText('الاسم الإنجليزي في المقاس ده'), {
      target: { value: 'hide' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() =>
      expect(fake.callsTo('POST', '/api/v1/label-design/versions')).toHaveLength(1),
    );
    const call = fake.callsTo('POST', '/api/v1/label-design/versions')[0]!;
    const base = defaultLabelDesign();
    expect(call.body).toEqual({
      basedOnVersionId: '9',
      design: {
        ...base,
        elements: { ...base.elements, nameEn: { ...base.elements.nameEn, show: true } },
        overrides: { '40x30': { elements: { nameEn: { show: false } } } },
      },
    });
    expect(call.idempotencyKey).toBeTruthy();
    expect(await screen.findByText('اتحفظ تصميم الملصق (نسخة 4).')).toBeTruthy();
  });

  it('the barcode is never lower than 5 mm; "Reset" brings the default design back', async () => {
    await openDesigner(bridge());
    const height = screen.getByLabelText<HTMLInputElement>(/ارتفاع الخطوط/);
    fireEvent.change(height, { target: { value: '4' } });
    expect(screen.getAllByText('من 5 إلى 20 مم، بنص ملّي.').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'حفظ' }).hasAttribute('disabled')).toBe(true);

    fireEvent.change(height, { target: { value: '12.5' } });
    expect(screen.getByRole('button', { name: 'حفظ' }).hasAttribute('disabled')).toBe(false);
    // Moving an element changes the order.
    fireEvent.click(screen.getByRole('button', { name: 'طلّع السعر لفوق' }));
    const order = () =>
      screen.getAllByTestId(/^label-element-/).map((li) => li.dataset['testid']!.slice(14));
    expect(order().indexOf('price')).toBeLessThan(order().indexOf('itemCode'));

    fireEvent.click(screen.getByRole('button', { name: 'رجّع التصميم الأصلي' }));
    expect(height.value).toBe('10');
    expect(order()).toEqual(defaultLabelDesign().order);
    expect(screen.queryByText('غير محفوظ')).toBeNull();
    expect(screen.getByRole('button', { name: 'حفظ' }).hasAttribute('disabled')).toBe(true);
  });
  it('a language for each element: price in English only, shop name in both, Arabic price on 40 × 30', async () => {
    const fake = bridge();
    await openDesigner(fake);
    const price = screen.getByTestId('label-element-price');
    fireEvent.click(
      within(within(price).getByRole('group', { name: 'لغة السعر' })).getByRole('button', {
        name: 'إنجليزي',
      }),
    );
    const shop = screen.getByTestId('label-element-shopName');
    fireEvent.click(within(shop).getByRole('switch', { name: 'اسم المحل' }));
    fireEvent.click(
      within(within(shop).getByRole('group', { name: 'لغة اسم المحل' })).getByRole('button', {
        name: 'الاتنين',
      }),
    );
    // Elements in one language only have no language choice.
    expect(
      within(screen.getByTestId('label-element-nameAr')).queryByRole('group', {
        name: /^لغة/,
      }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText('المقاس'), { target: { value: '40x30' } });
    fireEvent.change(screen.getByLabelText('لغة السعر في المقاس ده'), { target: { value: 'ar' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() =>
      expect(fake.callsTo('POST', '/api/v1/label-design/versions')).toHaveLength(1),
    );
    const base = defaultLabelDesign();
    expect(fake.callsTo('POST', '/api/v1/label-design/versions')[0]!.body).toEqual({
      basedOnVersionId: '9',
      design: {
        ...base,
        elements: {
          ...base.elements,
          price: { ...base.elements.price, lang: 'en' },
          shopName: { ...base.elements.shopName, show: true, lang: 'both' },
        },
        overrides: { '40x30': { elements: { price: { lang: 'ar' } } } },
      },
    });
  });
});
