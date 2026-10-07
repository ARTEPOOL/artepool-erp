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
    expect(within(nav).getByText('نقطة البيع').closest('[aria-disabled]')).toBeTruthy();
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
