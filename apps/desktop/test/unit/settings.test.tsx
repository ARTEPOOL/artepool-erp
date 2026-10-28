/**
 * T10: the app frame and Settings (design 13) against a scripted server: who sees Settings,
 * users and temporary codes, deactivating with a reason, role permissions, PCs, the audit log.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  AuditEntry,
  DeviceListItem,
  PermissionInfo,
  RoleInfo,
  UserListItem,
} from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { FakeBridge, ok, sessionView, signInAnswer, userView } from '../support/fake-bridge';

const OWNER_PERMISSIONS = [
  'users.view',
  'users.manage',
  'users.reset_credentials',
  'roles.manage',
  'system.devices.manage',
  'audit.view',
  'audit.verify',
  'audit.export',
];

const role = (patch: Partial<RoleInfo>): RoleInfo => ({
  id: '3',
  code: 'cashier',
  nameAr: 'أمين الصندوق',
  nameEn: 'Cashier',
  isSystem: true,
  isActive: true,
  requires2fa: false,
  maxDiscountBp: 500,
  maxDiscountFils: '500000',
  permissions: ['pos.sell'],
  activeUsers: 1,
  ...patch,
});

const ROLES = [
  role({ id: '1', code: 'owner', nameAr: 'المالك', nameEn: 'Owner', permissions: [] }),
  role({}),
];

const permission = (patch: Partial<PermissionInfo>): PermissionInfo => ({
  code: 'pos.sell',
  module: 'pos',
  nameAr: 'البيع في نقطة البيع',
  nameEn: 'Sell at the POS',
  isSensitive: false,
  approvable: false,
  ownerOnly: false,
  ...patch,
});

const PERMISSIONS = [
  permission({}),
  permission({ code: 'pos.no_sale', nameAr: 'فتح الدرج بدون بيع', nameEn: 'No Sale' }),
  permission({
    code: 'users.manage',
    module: 'users',
    nameAr: 'إدارة المستخدمين',
    nameEn: 'Manage users',
    ownerOnly: true,
  }),
];

const person = (patch: Partial<UserListItem>): UserListItem => ({
  id: '5',
  username: 'sara.cashier',
  displayNameAr: 'سارة علي',
  displayNameEn: 'Sara Ali',
  signInMethod: 'pin',
  roles: [{ id: '3', code: 'cashier', nameAr: 'أمين الصندوق', nameEn: 'Cashier' }],
  status: 'active',
  lockedMinutes: null,
  lastLoginAt: null,
  mustChange: false,
  isOwner: false,
  deactivatedAt: null,
  deactivationReason: null,
  ...patch,
});

const USERS = [
  person({
    id: '2',
    username: 'mohammed',
    displayNameAr: 'محمد ياسر',
    displayNameEn: 'Mohammed Yasser',
    signInMethod: 'password_totp',
    roles: [{ id: '1', code: 'owner', nameAr: 'المالك', nameEn: 'Owner' }],
    isOwner: true,
  }),
  person({}),
  person({
    id: '6',
    username: 'yousef.store',
    displayNameAr: 'يوسف إبراهيم',
    displayNameEn: 'Yousef Ibrahim',
    signInMethod: 'password',
    status: 'locked',
    lockedMinutes: 12,
  }),
  person({
    id: '7',
    username: 'mona.cashier',
    displayNameAr: 'منى خليل',
    displayNameEn: 'Mona Khalil',
    status: 'inactive',
    deactivationReason: 'انتهى عقدها',
  }),
];

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
  kioskLock: null,
  ...patch,
});

const entry = (patch: Partial<AuditEntry>): AuditEntry => ({
  id: '10',
  seq: '310',
  at: new Date().toISOString(),
  action: 'event:auth.signed_in',
  entityType: 'auth.users',
  entityId: '5',
  entityLabel: 'sara.cashier',
  user: { id: '5', username: 'sara.cashier', displayNameAr: 'سارة علي', displayNameEn: 'Sara Ali' },
  device: { id: '3', code: 'COUNTER-01' },
  reason: null,
  oldValues: null,
  newValues: { method: 'pin' },
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
    .on('GET', '/api/v1/users', ok({ users: USERS }))
    .on('GET', '/api/v1/roles', ok({ roles: ROLES, permissions: PERMISSIONS }));
}

async function signIn(bridge: FakeBridge) {
  render(<App bridge={bridge} />);
  await screen.findByRole('heading', { level: 1 });
  fireEvent.change(screen.getByLabelText('اسم المستخدم'), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'blue-pool-water' } });
  fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
  await screen.findByRole('heading', { name: 'أهلًا، محمد ياسر' });
}

async function openSettings(section?: string) {
  fireEvent.click(screen.getByRole('link', { name: 'الإعدادات' }));
  await screen.findByRole('heading', { name: 'المستخدمون والصلاحيات', level: 2 });
  if (section) {
    fireEvent.click(screen.getByRole('link', { name: section }));
    await screen.findByRole('heading', { name: section, level: 2 });
  }
}

/** The table row whose bold title is `name` (waits for the list to load). */
async function row(name: string): Promise<HTMLElement> {
  const title = await screen.findByText(name, { selector: 'tbody b, tbody b bdi' });
  return title.closest('tr')!;
}

describe('the app frame', () => {
  it('a cashier never sees Settings (the server refuses it anyway)', async () => {
    await signIn(signedInBridge(['pos.sell']));
    const nav = screen.getByRole('navigation', { name: 'القائمة' });
    expect(within(nav).queryByRole('link', { name: 'الإعدادات' })).toBeNull();
    // M5: the cashier's menu leads to the point of sale.
    expect(within(nav).getByRole('link', { name: 'نقطة البيع' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'فتح الإعدادات' })).toBeNull();
  });

  it('the owner opens Settings at Users; sections not built yet are greyed', async () => {
    await signIn(signedInBridge(OWNER_PERMISSIONS));
    await openSettings();
    const hub = screen.getByRole('navigation', { name: 'الإعدادات' });
    expect(within(hub).queryByRole('link', { name: /الشركة/ })).toBeNull();
    expect(within(hub).getByText('الشركة').closest('[aria-disabled]')).toBeTruthy();
    expect(within(hub).getByRole('link', { name: 'سجل المراقبة' })).toBeTruthy();
  });
});

describe('Settings → Users & permissions', () => {
  it('lists people with their sign-in method and status; never deleted, only deactivated', async () => {
    await signIn(signedInBridge(OWNER_PERMISSIONS));
    await openSettings();
    expect(within(await row('يوسف إبراهيم')).getByText('مقفل 12 دقيقة')).toBeTruthy();
    expect(within(await row('منى خليل')).getByText('معطّل')).toBeTruthy();
    expect(within(await row('محمد ياسر')).getByText('كلمة مرور + رمز تحقق')).toBeTruthy();
    expect(screen.getByText(/لا يُحذف مستخدم أبدًا/)).toBeTruthy();
    fireEvent.click(await row('منى خليل'));
    expect(await screen.findByText('معطّل · انتهى عقدها')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إعادة التفعيل' })).toBeTruthy();
  });

  it('creates a user; the temporary code is shown once with a fresh operation key', async () => {
    const bridge = signedInBridge(OWNER_PERMISSIONS).on(
      'POST',
      '/api/v1/users',
      ok(
        {
          user: person({
            id: '9',
            username: 'ali.cashier',
            displayNameAr: 'علي',
            displayNameEn: 'Ali',
          }),
          temporaryCode: '4821',
          kind: 'pin',
        },
        201,
      ),
    );
    await signIn(bridge);
    await openSettings();
    fireEvent.click(screen.getByRole('button', { name: 'مستخدم جديد' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('الاسم بالعربية'), { target: { value: 'علي' } });
    fireEvent.change(within(dialog).getByLabelText('الاسم بالإنجليزية'), {
      target: { value: 'Ali' },
    });
    fireEvent.change(within(dialog).getByLabelText('اسم الدخول'), {
      target: { value: 'Ali.Cashier' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إنشاء المستخدم' }));

    const shown = await screen.findByTestId('temporary-code');
    expect(shown.textContent).toBe('4821');
    expect(screen.getByText('رمز PIN المؤقت لـ علي')).toBeTruthy();
    const call = bridge.callsTo('POST', '/api/v1/users')[0]!;
    expect(call.body).toEqual({
      displayNameAr: 'علي',
      displayNameEn: 'Ali',
      username: 'ali.cashier',
      roleId: '3',
      signInMethod: 'pin',
    });
    expect(call.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    fireEvent.click(screen.getByRole('button', { name: 'تم' }));
    await waitFor(() => expect(screen.queryByTestId('temporary-code')).toBeNull());
  });

  it('deactivating needs a reason of at least 3 characters', async () => {
    const bridge = signedInBridge(OWNER_PERMISSIONS).on(
      'POST',
      '/api/v1/users/5/deactivate',
      ok(person({ status: 'inactive', deactivationReason: 'ترك العمل' })),
    );
    await signIn(bridge);
    await openSettings();
    fireEvent.click(await row('سارة علي'));
    fireEvent.click(await screen.findByRole('button', { name: 'تعطيل' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'تعطيل' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('السبب (إلزامي)'), {
      target: { value: 'ترك العمل' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تعطيل' }));
    expect(await screen.findByText('عُطّل المستخدم ولن يستطيع الدخول')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/users/5/deactivate')[0]?.body).toEqual({
      reason: 'ترك العمل',
    });
  });

  it('saves role permissions and the discount limit as whole numbers (no floats)', async () => {
    const bridge = signedInBridge(OWNER_PERMISSIONS).on('PATCH', '/api/v1/roles/3', ok(role({})));
    await signIn(bridge);
    await openSettings();
    fireEvent.click(await row('سارة علي'));
    await screen.findByRole('heading', { name: 'صلاحيات دور: أمين الصندوق' });
    const ownerOnly = screen.getByRole('switch', { name: /إدارة المستخدمين/ });
    expect(ownerOnly.hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('switch', { name: /فتح الدرج بدون بيع/ }));
    expect(screen.getByText('تعديلات غير محفوظة')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('النسبة'), { target: { value: '7.5' } });
    fireEvent.change(screen.getByLabelText('المبلغ (درهم)'), { target: { value: '1250.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الصلاحيات' }));
    expect(
      await screen.findByText('حُفظت الصلاحيات وتسري على كل مستخدمي الدور فورًا'),
    ).toBeTruthy();
    expect(bridge.callsTo('PATCH', '/api/v1/roles/3')[0]?.body).toEqual({
      permissions: ['pos.no_sale', 'pos.sell'],
      maxDiscountBp: 750,
      maxDiscountFils: '125050',
    });
  });

  it('unsaved permission changes must be saved or cancelled before choosing someone else', async () => {
    await signIn(signedInBridge(OWNER_PERMISSIONS));
    await openSettings();
    fireEvent.click(await row('سارة علي'));
    fireEvent.click(await screen.findByRole('switch', { name: /فتح الدرج بدون بيع/ }));
    fireEvent.click(await row('يوسف إبراهيم'));
    expect(
      await screen.findByText('لديك تعديلات صلاحيات غير محفوظة؛ احفظها أو ألغها أولًا'),
    ).toBeTruthy();
    expect((await row('سارة علي')).getAttribute('aria-selected')).toBe('true');
  });

  it('the owner role is shown as always having every permission', async () => {
    await signIn(signedInBridge(OWNER_PERMISSIONS));
    await openSettings();
    fireEvent.click(await row('محمد ياسر'));
    expect(await screen.findByText('دور المالك يملك كل الصلاحيات دائمًا.')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'تعطيل' })).toBeNull();
  });
});

describe('Settings → Devices', () => {
  const devicesBridge = () =>
    signedInBridge(OWNER_PERMISSIONS)
      .on(
        'GET',
        '/api/v1/devices',
        ok({
          devices: [
            device({
              id: '2',
              code: 'OFFICE-01',
              name: 'مكتب المالك',
              kind: 'office',
              isCurrent: true,
            }),
            device({}),
          ],
          openCode: null,
        }),
      )
      .on('POST', '/api/v1/devices/3/revoke', ok({ ok: true }))
      .on(
        'POST',
        '/api/v1/devices/enrollment-codes',
        ok({ code: 'K7Q-4MX-92P', expiresAt: new Date(Date.now() + 600_000).toISOString() }, 201),
      );

  it('the owner turns the screen lock back on for office PCs (decision 0079)', async () => {
    const bridge = signedInBridge([...OWNER_PERMISSIONS, 'system.settings.edit'])
      .on('GET', '/api/v1/devices', ok({ devices: [device({})], openCode: null }))
      .on('GET', '/api/v1/settings/screen-lock', ok({ officeMinutes: 0, posMinutes: 0 }))
      .on('PUT', '/api/v1/settings/screen-lock', ok({ officeMinutes: 15, posMinutes: 0 }));
    await signIn(bridge);
    await openSettings('الأجهزة والطابعات');
    const office = await screen.findByRole('switch', { name: 'قفل أجهزة المكتب' });
    expect((office as HTMLInputElement).checked).toBe(false);
    fireEvent.click(office);
    expect(screen.getByLabelText('بعد كم دقيقة بدون استخدام (1–240)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() =>
      expect(bridge.callsTo('PUT', '/api/v1/settings/screen-lock')[0]?.body).toEqual({
        officeMinutes: 15,
        posMinutes: 0,
      }),
    );
  });

  it("the owner turns a POS PC's kiosk lock off for 1 hour with a reason and the code (0089)", async () => {
    const offUntil = new Date(Date.now() + 3_600_000).toISOString();
    const bridge = signedInBridge(OWNER_PERMISSIONS)
      .on(
        'GET',
        '/api/v1/devices',
        ok({
          devices: [
            device({
              kioskLock: { locked: true, switchedOff: false, offUntil: null, ownerSignedIn: false },
            }),
          ],
          openCode: null,
        }),
        ok({
          devices: [
            device({
              kioskLock: { locked: false, switchedOff: true, offUntil, ownerSignedIn: false },
            }),
          ],
          openCode: null,
        }),
      )
      .on(
        'POST',
        '/api/v1/devices/3/kiosk-lock',
        ok({ locked: false, switchedOff: true, offUntil, ownerSignedIn: false }),
      )
      .on(
        'GET',
        '/api/v1/kiosk/alerts',
        ok({
          alerts: [
            {
              id: '9',
              alertType: 'kiosk_exit_attempt',
              createdAt: new Date().toISOString(),
              deviceId: '3',
              deviceCode: 'COUNTER-01',
              deviceName: 'كاشير المعرض',
              params: { kind: 'close_refused' },
            },
          ],
        }),
      );
    await signIn(bridge);
    await openSettings('الأجهزة والطابعات');
    const counter = await row('COUNTER-01');
    expect(within(counter).getByText('قفل الجهاز شغال')).toBeTruthy();
    expect(await screen.findByText(/حد حاول يقفل برنامج الكاشير/)).toBeTruthy();

    fireEvent.click(within(counter).getByRole('button', { name: 'إيقاف…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'ساعة' }));
    fireEvent.change(within(dialog).getByLabelText('السبب'), {
      target: { value: 'تعريف الطابعة' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إيقاف…' }));
    expect(await within(dialog).findByText('اكتب أرقام كود التحقق الستة.')).toBeTruthy();
    fireEvent.paste(within(dialog).getByLabelText('رقم 1'), {
      clipboardData: { getData: () => '654321' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إيقاف…' }));
    await waitFor(() =>
      expect(bridge.callsTo('POST', '/api/v1/devices/3/kiosk-lock')[0]?.body).toEqual({
        on: false,
        minutes: 60,
        reason: 'تعريف الطابعة',
        code: '654321',
      }),
    );
    expect(await within(await row('COUNTER-01')).findByText(/القفل متوقف حتى الساعة/)).toBeTruthy();
  });

  it('revokes another PC with a reason; this PC cannot be revoked from itself', async () => {
    const bridge = devicesBridge();
    await signIn(bridge);
    await openSettings('الأجهزة والطابعات');
    const office = await row('OFFICE-01');
    expect(within(office).getByText('هذا الجهاز')).toBeTruthy();
    expect(within(office).queryByRole('button', { name: 'إلغاء الصلاحية' })).toBeNull();

    fireEvent.click(
      within(await row('COUNTER-01')).getByRole('button', { name: 'إلغاء الصلاحية' }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('السبب (إلزامي)'), {
      target: { value: 'سُرق الجهاز' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء الصلاحية' }));
    expect(await screen.findByText(/أُلغيت صلاحية COUNTER-01/)).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/devices/3/revoke')[0]?.body).toEqual({
      reason: 'سُرق الجهاز',
    });
  });

  it('shows a new enrollment code once, with the minutes left', async () => {
    await signIn(devicesBridge());
    await openSettings('الأجهزة والطابعات');
    expect(screen.getByText('لا يوجد رمز مفتوح.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'رمز جديد' }));
    expect((await screen.findByTestId('enrollment-code')).textContent).toBe('K7Q-4MX-92P');
    expect(screen.getByText(/صالح (10:00|9:5\d) دقيقة ولمرة واحدة/)).toBeTruthy();
  });

  it('shows who may sign in without the phone code, and ends that trust (decision 0027)', async () => {
    const trusted = {
      userId: '1',
      displayNameAr: 'محمد',
      displayNameEn: 'Mohammed',
      expiresAt: '2026-11-06T08:00:00.000Z',
    };
    const bridge = signedInBridge(OWNER_PERMISSIONS)
      .on(
        'GET',
        '/api/v1/devices',
        ok({
          devices: [
            device({
              id: '2',
              code: 'OFFICE-01',
              name: 'مكتب المالك',
              kind: 'office',
              isCurrent: true,
              trustedFor: [trusted],
            }),
            device({}),
          ],
          openCode: null,
        }),
      )
      .on('POST', '/api/v1/devices/2/end-trust', ok({ ended: 1 }));
    await signIn(bridge);
    await openSettings('الأجهزة والطابعات');
    const office = await row('OFFICE-01');
    expect(within(office).getByText('بدون رمز الهاتف هنا لـ محمد حتى 06/11/2026')).toBeTruthy();
    expect(
      within(await row('COUNTER-01')).queryByRole('button', { name: 'إلغاء الثقة' }),
    ).toBeNull();

    fireEvent.click(within(office).getByRole('button', { name: 'إلغاء الثقة' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/سيُطلب رمز الهاتف من جديد على OFFICE-01 لكل من: محمد/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء الثقة' }));
    expect(await screen.findByText(/أُلغيت الثقة/)).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/devices/2/end-trust')).toHaveLength(1);
    expect(bridge.callsTo('POST', '/api/v1/devices/2/end-trust')[0]?.idempotencyKey).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });
});

describe('Settings → System health (decision 0086)', () => {
  const run = (patch: Record<string, unknown> = {}) => ({
    id: '1',
    status: 'success',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    fileName: 'artepool-20261019-100000Z.dump',
    sizeBytes: 1_234_567,
    errorMessage: null,
    ...patch,
  });
  const health = (patch: Record<string, unknown> = {}) => ({
    problems: ['offsite_not_set_up', 'offline_due'],
    local: { last: run(), lastFailure: null, maxAgeMinutes: 90, folder: 'D:\\ARTEPOOL\\backups' },
    offsite: {
      last: null,
      lastFailure: null,
      maxAgeHours: 30,
      keySet: false,
      driveConnected: false,
      google: { chooseAccount: true, code: true },
    },
    offline: { last: null, intervalDays: 7 },
    restoreTest: { last: null, intervalDays: 30 },
    integrity: { last: { status: 'ok', finishedAt: new Date().toISOString(), checks: {} } },
    disk: { freeBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
    requests: [],
    ...patch,
  });
  const identity = `AGE-SECRET-KEY-1${'Q'.repeat(52)}ABCDEF`;
  const recipient = `age1${'q'.repeat(58)}`;

  it('the owner sees what needs attention, backs up now and creates the backup key', async () => {
    const bridge = signedInBridge([
      ...OWNER_PERMISSIONS,
      'system.health.view',
      'system.backup.manage',
      'system.backup.restore_test',
    ])
      .on('GET', '/api/v1/health/system', ok(health()))
      .on('POST', '/api/v1/backup/requests', ok({ id: '5' }, 201))
      .on('POST', '/api/v1/backup/key', ok({ identity, recipient }))
      .on('POST', '/api/v1/backup/key/confirm', ok({ ok: true }));
    await signIn(bridge);
    await openSettings();
    fireEvent.click(screen.getByRole('link', { name: 'النسخ الاحتياطي' }));
    await screen.findByRole('heading', { name: 'صحة النظام والنسخ الاحتياطي', level: 2 });
    expect(await screen.findByText(/النسخة الخارجية لسه متظبطتش/)).toBeTruthy();
    expect(screen.getByText(/جه وقت النسخة الأسبوعية/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'نسخة الآن' }));
    await waitFor(() =>
      expect(bridge.callsTo('POST', '/api/v1/backup/requests')[0]?.body).toEqual({
        kind: 'backup_now',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'إنشاء مفتاح النسخ' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'إنشاء مفتاح النسخ' }));
    expect(await screen.findByText(identity)).toBeTruthy();
    dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('اكتب آخر 6 حروف في المفتاح'), {
      target: { value: 'XXXXXX' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'أنا احتفظت بالمفتاح' }));
    expect(await within(dialog).findByText('دول مش آخر 6 حروف في المفتاح.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/backup/key/confirm')).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText('اكتب آخر 6 حروف في المفتاح'), {
      target: { value: 'abcdef' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'أنا احتفظت بالمفتاح' }));
    await waitFor(() =>
      expect(bridge.callsTo('POST', '/api/v1/backup/key/confirm')[0]?.body).toEqual({ recipient }),
    );
  });

  it('connects Google Drive without typing any ID (the code way, in a browser)', async () => {
    const bridge = signedInBridge([
      ...OWNER_PERMISSIONS,
      'system.health.view',
      'system.backup.manage',
    ])
      .on('GET', '/api/v1/health/system', ok(health()))
      .on(
        'POST',
        '/api/v1/backup/drive/connect',
        ok({
          userCode: 'ABCD-EFGH',
          verificationUrl: 'https://www.google.com/device',
          expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
          intervalSeconds: 5,
        }),
      );
    await signIn(bridge);
    await openSettings();
    fireEvent.click(screen.getByRole('link', { name: 'النسخ الاحتياطي' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ربط Google Drive' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(/Client ID/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'اعرض الكود' }));
    expect(await within(dialog).findByText('ABCD-EFGH')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/backup/drive/connect')[0]?.body ?? {}).toEqual({});
  });

  const update = (patch: Record<string, unknown> = {}) => ({
    currentVersion: '1.0.0',
    checkedAt: new Date().toISOString(),
    checkError: null,
    checking: false,
    available: {
      version: '1.1.0',
      notesAr: 'الكاشير بقى أسرع.',
      notesEn: 'The POS is faster.',
      publishedAt: new Date().toISOString(),
    },
    downloadStatus: 'ready',
    waitingReason: 'outside_window',
    lastResult: {
      ok: false,
      from: '0.9.0',
      to: '1.0.0',
      at: new Date().toISOString(),
      step: 'migrate',
    },
    window: { startHour: 2, endHour: 5 },
    request: null,
    ...patch,
  });

  it('shows the update with its notes, the last result, and "Install now" after confirming (0108)', async () => {
    const bridge = signedInBridge([
      ...OWNER_PERMISSIONS,
      'system.health.view',
      'system.update.manage',
    ])
      .on('GET', '/api/v1/health/system', ok(health()))
      .on('GET', '/api/v1/system/update', ok(update()))
      .on('POST', '/api/v1/system/update/install-now', ok({ version: '1.1.0' }, 201))
      .on('PUT', '/api/v1/system/update/window', ok({ ok: true }));
    await signIn(bridge);
    await openSettings();
    fireEvent.click(screen.getByRole('link', { name: 'النسخ الاحتياطي' }));
    const card = await screen.findByTestId('updates-card');
    expect(await within(card).findByText('الكاشير بقى أسرع.')).toBeTruthy();
    expect(within(card).getByText(/هتتسطّب لوحدها في وقت التحديث بالليل/)).toBeTruthy();
    expect(within(card).getByText(/تغييرات قاعدة البيانات/)).toBeTruthy();
    expect(within(card).getByText('رجعنا للنسخة القديمة')).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'ثبّت دلوقتي' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/عمره ما بيبدأ وفيه وردية مفتوحة/)).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/system/update/install-now')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'ثبّت دلوقتي' }));
    await waitFor(() =>
      expect(bridge.callsTo('POST', '/api/v1/system/update/install-now')).toHaveLength(1),
    );

    fireEvent.click(within(card).getByRole('button', { name: 'غيّر' }));
    const windowDialog = await screen.findByRole('dialog');
    fireEvent.change(within(windowDialog).getByLabelText('من'), { target: { value: '23' } });
    fireEvent.change(within(windowDialog).getByLabelText('لحد'), { target: { value: '4' } });
    fireEvent.click(within(windowDialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() =>
      expect(bridge.callsTo('PUT', '/api/v1/system/update/window')[0]?.body).toEqual({
        startHour: 23,
        endHour: 4,
      }),
    );
  });

  it('without internet says updates wait; without the permission there is no "Install now"', async () => {
    const bridge = signedInBridge([...OWNER_PERMISSIONS, 'system.health.view'])
      .on('GET', '/api/v1/health/system', ok(health()))
      .on(
        'GET',
        '/api/v1/system/update',
        ok(update({ checkError: 'getaddrinfo ENOTFOUND', available: null, lastResult: null })),
      );
    await signIn(bridge);
    await openSettings();
    fireEvent.click(screen.getByRole('link', { name: 'النسخ الاحتياطي' }));
    const card = await screen.findByTestId('updates-card');
    expect(within(card).getByText(/مفيش إنترنت دلوقتي/)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'ثبّت دلوقتي' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'غيّر' })).toBeNull();
  });

  it('release notes show one point per line (0110)', async () => {
    const notesAr =
      'صحة جهاز السيرفر في مكان واحد.\n\n- كارت جديد «جهاز السيرفر».\n- دوس **افحص دلوقتي** لما تحب.';
    const bridge = signedInBridge([...OWNER_PERMISSIONS, 'system.health.view'])
      .on('GET', '/api/v1/health/system', ok(health()))
      .on(
        'GET',
        '/api/v1/system/update',
        ok(update({ available: { ...update().available, notesAr } })),
      );
    await signIn(bridge);
    await openSettings();
    fireEvent.click(screen.getByRole('link', { name: 'النسخ الاحتياطي' }));
    const notes = await screen.findByTestId('release-notes');
    expect(within(notes).getByText('صحة جهاز السيرفر في مكان واحد.').tagName).toBe('P');
    expect(
      within(notes)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['كارت جديد «جهاز السيرفر».', 'دوس افحص دلوقتي لما تحب.']);
    // "**…**" is shown bold, never as asterisks.
    expect(within(notes).getByText('افحص دلوقتي').tagName).toBe('B');
    expect(notes.textContent).not.toContain('*');
  });

  it('"Check now" asks the server PC and says it is checking; up to date without a new version (0110)', async () => {
    const bridge = signedInBridge([
      ...OWNER_PERMISSIONS,
      'system.health.view',
      'system.update.manage',
    ])
      .on('GET', '/api/v1/health/system', ok(health()))
      .on(
        'GET',
        '/api/v1/system/update',
        ok(update({ available: null, lastResult: null })),
        ok(update({ available: null, lastResult: null, checking: true })),
      )
      .on('POST', '/api/v1/system/update/check', ok({ ok: true }, 201));
    await signIn(bridge);
    await openSettings();
    fireEvent.click(screen.getByRole('link', { name: 'النسخ الاحتياطي' }));
    const card = await screen.findByTestId('updates-card');
    expect(await within(card).findByText('على آخر نسخة')).toBeTruthy();
    expect(within(card).queryByTestId('update-available')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'افحص دلوقتي' }));
    await waitFor(() =>
      expect(bridge.callsTo('POST', '/api/v1/system/update/check')).toHaveLength(1),
    );
    expect(await within(card).findByText(/بندوّر على تحديثات/)).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'افحص دلوقتي' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('shows the server PC: disks, services, certificates, clock and the UPS (M6.2 part H)', async () => {
    const GB = 1024 ** 3;
    const serverHealth = {
      problems: ['disk_low', 'backup_service_down', 'certificate_expiring', 'ups_unconfirmed'],
      disks: [
        { disk: 'data', path: 'C:\\', freeBytes: 8 * GB, totalBytes: 100 * GB, level: 'warning' },
        { disk: 'backups', path: 'D:\\', freeBytes: 300 * GB, totalBytes: 500 * GB, level: 'ok' },
      ],
      services: { backupHeartbeatAt: null, backupRunning: false },
      wal: { enabled: true, lastArchivedAt: null, lastFailedAt: null, failing: false },
      certificate: {
        server: { expiresAt: '2026-12-01T00:00:00.000Z', daysLeft: 30, level: 'warning' },
        rootCa: { expiresAt: '2046-10-25T00:00:00.000Z', daysLeft: 7300, level: 'ok' },
        lastRenewedAt: null,
        lastAttemptAt: null,
        renewalError: null,
      },
      clock: { serverTime: new Date().toISOString(), latestRecordAt: null, isBehind: false },
      ups: { confirmedAt: null, due: true, reminderDays: 182 },
    };
    const bridge = signedInBridge([
      ...OWNER_PERMISSIONS,
      'system.health.view',
      'system.health.manage',
      'system.backup.manage',
    ])
      .on('GET', '/api/v1/health/system', ok(health()))
      .on('GET', '/api/v1/system/server-health', ok(serverHealth))
      .on(
        'POST',
        '/api/v1/system/server-health/ups',
        ok({ confirmedAt: new Date().toISOString() }),
      );
    await signIn(bridge);
    await openSettings();
    fireEvent.click(screen.getByRole('link', { name: 'النسخ الاحتياطي' }));
    const card = await screen.findByTestId('server-health');
    const disk = await within(card).findByTestId('health-disk-data');
    expect(within(disk).getByText('هارد قاعدة البيانات')).toBeTruthy();
    expect(within(disk).getByText('قريب')).toBeTruthy();
    expect(within(card).getByTestId('health-services').textContent).toContain(
      'خدمة النسخ الاحتياطي واقفة',
    );
    expect(within(card).getByTestId('health-certificate').textContent).toContain('فاضل 30 يوم');
    expect(within(card).getByTestId('health-root-ca').textContent).toContain(
      'بتتجدد بإيد الدعم الفني',
    );
    expect(within(card).getByTestId('health-key').textContent).toContain('لسه ماتعملش');
    const ups = within(card).getByTestId('health-ups');
    expect(ups.textContent).toContain('جهاز السيرفر متوصل بـ UPS؟');
    fireEvent.click(within(ups).getByRole('button', { name: 'أيوه، متوصل بـ UPS' }));
    await waitFor(() =>
      expect(bridge.callsTo('POST', '/api/v1/system/server-health/ups')).toHaveLength(1),
    );
  });

  it('is not offered to anyone else (the server refuses it anyway)', async () => {
    await signIn(signedInBridge(OWNER_PERMISSIONS));
    await openSettings();
    const hub = screen.getByRole('navigation', { name: 'الإعدادات' });
    expect(within(hub).queryByRole('link', { name: /النسخ الاحتياطي/ })).toBeNull();
  });
});

describe('Settings → Audit log', () => {
  const auditBridge = () =>
    signedInBridge(OWNER_PERMISSIONS)
      .on(
        'GET',
        '/api/v1/audit',
        ok({
          entries: [
            entry({}),
            entry({
              id: '11',
              seq: '309',
              action: 'update',
              entityLabel: 'sara.cashier',
              user: {
                id: '2',
                username: 'mohammed',
                displayNameAr: 'محمد ياسر',
                displayNameEn: 'Mohammed Yasser',
              },
              device: { id: '2', code: 'OFFICE-01' },
              oldValues: { display_name_en: 'Sarah' },
              newValues: { display_name_en: 'Sara Ali' },
            }),
          ],
          nextBefore: null,
        }),
      )
      .on('GET', '/api/v1/audit/chain', ok({ lastSeq: '310', fingerprint: 'ab', lastCheck: null }))
      .on(
        'POST',
        '/api/v1/audit/verify',
        ok({
          lastSeq: '310',
          fingerprint: 'ab',
          lastCheck: {
            at: new Date().toISOString(),
            ok: true,
            rowsChecked: '310',
            firstBadSeq: null,
          },
        }),
      );

  it('shows entries in plain words, with before and after for a change', async () => {
    const bridge = auditBridge();
    await signIn(bridge);
    await openSettings('سجل المراقبة');
    expect(await screen.findByText('تسجيل دخول', { selector: 'b' })).toBeTruthy();
    fireEvent.click(await row('تعديل مستخدم'));
    const details = screen
      .getByRole('heading', { name: 'تفاصيل التغيير' })
      .closest('div')!.parentElement!;
    expect(within(details).getByText('الاسم بالإنجليزية')).toBeTruthy();
    expect(within(details).getByText('Sarah')).toBeTruthy();
    expect(within(details).getByText('Sara Ali')).toBeTruthy();
    // Today in Al Ain time, newest first.
    expect(bridge.callsTo('GET', '/api/v1/audit')[0]?.path).toMatch(
      /from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&limit=50$/,
    );
  });

  it('filters by kind of action, and verifies the chain on request', async () => {
    const bridge = auditBridge();
    await signIn(bridge);
    await openSettings('سجل المراقبة');
    expect(await screen.findByText('لم يُتحقق بعد')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('الإجراء'), { target: { value: 'security' } });
    await waitFor(() =>
      expect(bridge.callsTo('GET', '/api/v1/audit').at(-1)?.path).toContain('kind=security'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'تحقق الآن' }));
    expect(
      await screen.findByText('السلسلة سليمة: فُحص 310 سجلًا ولم يُعدَّل أي منها'),
    ).toBeTruthy();
  });
});
