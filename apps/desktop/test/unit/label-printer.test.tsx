/**
 * Settings → Devices → the label printer of this PC (decision 0096), against a scripted server: the
 * saved settings are shown, a change is sent as PUT /devices/me/label-printer, and a value out of
 * range keeps the save button off.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LabelPrinterConfig } from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { FakeBridge, ok, sessionView, signInAnswer, userView } from '../support/fake-bridge';

const OFFICE = { id: '2', code: 'OFFICE-01', name: 'Owner office', kind: 'office' as const };
const SAVED: LabelPrinterConfig = {
  printer: null,
  dpi: 203,
  printableWidthMm: 48,
  offsetXMm: 0,
  offsetYMm: 0,
  darkness: 8,
  speed: 3,
  mode: 'driver',
  gapMm: 2,
  flip: false,
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
        device: OFFICE,
        permissions: ['system.devices.manage'],
      }),
    )
    .on(
      'GET',
      '/api/v1/devices/me',
      ok({ device: OFFICE, keyExpiresAt: '2027-10-07', labelPrinter: SAVED }),
    )
    .on('GET', '/api/v1/devices', ok({ devices: [], openCode: null }))
    .on('GET', '/api/v1/label-sizes', ok({ labelSizes: [], maxWidthMm: 50 }))
    .on('PUT', '/api/v1/devices/me/label-printer', (request) => ok({ labelPrinter: request.body }));
}

async function openDevices(fake: FakeBridge) {
  render(<App bridge={fake} />);
  await screen.findByRole('heading', { level: 1 });
  fireEvent.change(screen.getByLabelText('اسم المستخدم'), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'blue-pool-water' } });
  fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
  await screen.findByRole('heading', { name: 'أهلًا، محمد ياسر' });
  fireEvent.click(screen.getByRole('link', { name: 'الإعدادات' }));
  await screen.findByRole('navigation', { name: 'الإعدادات' });
  if (!screen.queryByRole('heading', { name: 'الأجهزة والطابعات', level: 2 })) {
    fireEvent.click(screen.getByRole('link', { name: 'الأجهزة والطابعات' }));
  }
  await screen.findByRole('heading', { name: 'طابعة الملصقات في هذا الجهاز' });
}

describe('Settings → Devices → label printer of this PC', () => {
  it('shows the saved settings and saves a new offset', async () => {
    const fake = bridge();
    await openDevices(fake);
    const width = screen.getByLabelText<HTMLInputElement>(/عرض الطباعة/);
    expect(width.value).toBe('48');
    fireEvent.change(screen.getByLabelText(/تحريك لليمين/), { target: { value: '1.5' } });
    fireEvent.change(screen.getByLabelText(/تحريك للأسفل/), { target: { value: '-0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ طابعة الملصقات' }));
    await waitFor(() =>
      expect(fake.callsTo('PUT', '/api/v1/devices/me/label-printer')).toHaveLength(1),
    );
    const [call] = fake.callsTo('PUT', '/api/v1/devices/me/label-printer');
    expect(call!.body).toEqual({ ...SAVED, offsetXMm: 1.5, offsetYMm: -0.5 });
    expect(call!.idempotencyKey).toBeTruthy();
  });

  it('a value out of range says so and cannot be saved', async () => {
    const fake = bridge();
    await openDevices(fake);
    fireEvent.change(screen.getByLabelText(/تحريك لليمين/), { target: { value: '12' } });
    expect(await screen.findByText(/رقم من -10 إلى 10 مم/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'حفظ طابعة الملصقات' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('direct printing (TSPL): the gap and the direction are asked for and saved (0100)', async () => {
    const fake = bridge();
    await openDevices(fake);
    // The driver's own tips while printing through the driver; no gap field.
    expect(screen.queryByLabelText(/المسافة بين الملصقات/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'مباشرة (TSPL)' }));
    const gap = screen.getByLabelText<HTMLInputElement>(/المسافة بين الملصقات/);
    expect(gap.value).toBe('2');
    fireEvent.change(gap, { target: { value: '12' } });
    expect(await screen.findByText(/رقم من 0 إلى 10 مم/)).toBeTruthy();
    fireEvent.change(gap, { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('switch', { name: /اقلب الطباعة/ }));
    expect(screen.getByText(/الطباعة المباشرة بتبعت الملصق للطابعة بلغتها/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ طابعة الملصقات' }));
    await waitFor(() =>
      expect(fake.callsTo('PUT', '/api/v1/devices/me/label-printer')).toHaveLength(1),
    );
    expect(fake.callsTo('PUT', '/api/v1/devices/me/label-printer')[0]!.body).toEqual({
      ...SAVED,
      mode: 'tspl',
      gapMm: 2.5,
      flip: true,
    });
  });
});
