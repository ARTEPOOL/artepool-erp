/**
 * M3-T12: the default warehouse per PC in Settings → Devices, against a scripted server. The
 * field shows only with more than one active warehouse (and only to someone who may read them);
 * a choice is saved at once as `{ defaultWarehouseId }`.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DeviceListItem, WarehouseItem } from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import {
  failure,
  FakeBridge,
  ok,
  sessionView,
  signInAnswer,
  userView,
} from '../support/fake-bridge';

const device = (patch: Partial<DeviceListItem>): DeviceListItem => ({
  id: '3',
  code: 'COUNTER-01',
  name: 'كاشير المعرض',
  kind: 'pos',
  status: 'active',
  enrolledAt: '2026-10-01T08:00:00.000Z',
  keyExpiresAt: '2027-10-01T08:00:00.000Z',
  lastSeenAt: null,
  lastIp: null,
  appVersion: '0.1.0',
  revokedAt: null,
  revokeReason: null,
  isCurrent: false,
  defaultWarehouseId: null,
  trustedFor: [],
  drawer: null,
  ...patch,
});

const DEVICES = [
  device({ id: '2', code: 'OFFICE-01', name: 'مكتب المالك', kind: 'office', isCurrent: true }),
  device({}),
  device({ id: '4', code: 'OLD-01', status: 'revoked', revokeReason: 'تالف' }),
];

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

const SITE = warehouse({
  id: '2',
  code: 'SITE-1',
  nameAr: 'موقع الجيمي',
  nameEn: 'Jimi site',
  warehouseType: 'site',
  isDefault: false,
});
const OLD = warehouse({ id: '3', code: 'OLD', isDefault: false, isActive: false });

function bridgeWith(warehouses: WarehouseItem[], permissions: string[]) {
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
    .on('GET', '/api/v1/devices', ok({ devices: DEVICES, openCode: null }))
    .on('GET', '/api/v1/warehouses', ok({ warehouses }));
}

const OWNER = ['system.devices.manage', 'warehouses.manage'];

async function openDevices(bridge: FakeBridge) {
  render(<App bridge={bridge} />);
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
  await screen.findByRole('heading', { name: 'الأجهزة والطابعات', level: 2 });
}

async function row(code: string): Promise<HTMLElement> {
  const title = await screen.findByText(code, { selector: 'tbody b bdi' });
  return title.closest('tr')!;
}

describe('Settings → Devices → warehouse per PC', () => {
  it('is hidden with only one active warehouse', async () => {
    const bridge = bridgeWith([warehouse({}), OLD], OWNER);
    await openDevices(bridge);
    await row('COUNTER-01');
    await waitFor(() => expect(bridge.callsTo('GET', '/api/v1/warehouses')).toHaveLength(1));
    expect(screen.queryByRole('columnheader', { name: 'المستودع' })).toBeNull();
    expect(screen.queryByLabelText('مستودع COUNTER-01')).toBeNull();
  });

  it('is hidden (and not asked for) without the right to read the warehouses', async () => {
    const bridge = bridgeWith([warehouse({}), SITE], ['system.devices.manage']);
    await openDevices(bridge);
    await row('COUNTER-01');
    expect(screen.queryByLabelText('مستودع COUNTER-01')).toBeNull();
    expect(bridge.callsTo('GET', '/api/v1/warehouses')).toHaveLength(0);
  });

  it('with two warehouses: active PCs get the field, and a choice sends the PATCH', async () => {
    const bridge = bridgeWith([warehouse({}), SITE, OLD], OWNER);
    bridge.on('PATCH', '/api/v1/devices/3', ok({ ok: true }));
    await openDevices(bridge);
    const select = await screen.findByLabelText('مستودع COUNTER-01');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => [(o as HTMLOptionElement).value, o.textContent]),
    ).toEqual([
      ['', 'المستودع الافتراضي'],
      ['1', 'MAIN · المستودع الرئيسي'],
      ['2', 'SITE-1 · موقع الجيمي'],
    ]);
    // A revoked PC has no field.
    expect(screen.queryByLabelText('مستودع OLD-01')).toBeNull();

    fireEvent.change(select, { target: { value: '2' } });
    await waitFor(() => expect(bridge.callsTo('PATCH', '/api/v1/devices/3')).toHaveLength(1));
    expect(bridge.callsTo('PATCH', '/api/v1/devices/3')[0]!.body).toEqual({
      defaultWarehouseId: '2',
    });
    expect(bridge.callsTo('PATCH', '/api/v1/devices/3')[0]!.idempotencyKey).toBeTruthy();
    expect(await screen.findByText('حُفظ مستودع COUNTER-01.')).toBeTruthy();
  });

  it('back to the default sends null; a refusal goes back and says why', async () => {
    const devices = [DEVICES[0]!, device({ defaultWarehouseId: '2' })];
    const bridge = bridgeWith([warehouse({}), SITE], OWNER)
      .on('GET', '/api/v1/devices', ok({ devices, openCode: null }))
      .on('PATCH', '/api/v1/devices/3', failure(403, 'FORBIDDEN'));
    await openDevices(bridge);
    const select = await screen.findByLabelText<HTMLSelectElement>('مستودع COUNTER-01');
    expect(select.value).toBe('2');
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(bridge.callsTo('PATCH', '/api/v1/devices/3')).toHaveLength(1));
    expect(bridge.callsTo('PATCH', '/api/v1/devices/3')[0]!.body).toEqual({
      defaultWarehouseId: null,
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    await waitFor(() => expect(select.value).toBe('2'));
  });
});
