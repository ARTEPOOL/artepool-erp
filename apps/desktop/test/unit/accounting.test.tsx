/**
 * T12: Accounting (decisions 0018, 0035) against a scripted server: the chart as a tree, accounts
 * in use and why they are locked, a new sub-account, event links with only suitable accounts, and
 * the translated rule when the server refuses.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AccountItem, AccountLink, AccountsResponse } from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import {
  failure,
  FakeBridge,
  ok,
  sessionView,
  signInAnswer,
  userView,
} from '../support/fake-bridge';

const account = (patch: Partial<AccountItem>): AccountItem => ({
  id: '1',
  code: '1000',
  nameAr: 'الأصول',
  nameEn: 'Assets',
  accountType: 'asset',
  parentId: null,
  isPostable: true,
  isControl: false,
  isContra: false,
  isActive: true,
  inUse: null,
  rowVersion: 1,
  ...patch,
});

// Sent in code order, as the server does; the screen builds the tree.
const ACCOUNTS: AccountItem[] = [
  account({ id: '1', code: '1000', nameAr: 'الأصول', nameEn: 'Assets', isPostable: false }),
  account({
    id: '2',
    code: '1100',
    nameAr: 'النقد والبنوك',
    nameEn: 'Cash and bank',
    parentId: '1',
    isPostable: false,
  }),
  account({
    id: '3',
    code: '1110',
    nameAr: 'النقد في أدراج نقاط البيع',
    nameEn: 'Cash on hand – POS drawers',
    parentId: '2',
    inUse: 'payment_method',
  }),
  account({
    id: '4',
    code: '1200',
    nameAr: 'الذمم المدينة',
    nameEn: 'Receivables',
    parentId: '1',
    isPostable: false,
  }),
  account({
    id: '5',
    code: '1210',
    nameAr: 'ذمم العملاء',
    nameEn: 'Accounts receivable – customers',
    parentId: '4',
    isControl: true,
    inUse: 'event_link',
    rowVersion: 4,
  }),
  account({
    id: '6',
    code: '1230',
    nameAr: 'ذمم مدينة أخرى',
    nameEn: 'Other receivables',
    parentId: '4',
  }),
  account({
    id: '10',
    code: '1240',
    nameAr: 'ذمم قديمة',
    nameEn: 'Old receivables',
    parentId: '4',
    isControl: true,
    isActive: false,
  }),
  account({
    id: '11',
    code: '1250',
    nameAr: 'ذمم عملاء المشاريع',
    nameEn: 'Project customers',
    parentId: '4',
    isControl: true,
  }),
  account({
    id: '7',
    code: '2000',
    nameAr: 'الالتزامات',
    nameEn: 'Liabilities',
    accountType: 'liability',
    isPostable: false,
  }),
  account({
    id: '8',
    code: '2130',
    nameAr: 'ضريبة القيمة المضافة المستحقة',
    nameEn: 'VAT payable',
    accountType: 'liability',
    parentId: '7',
    inUse: 'event_link',
  }),
  account({
    id: '9',
    code: '2140',
    nameAr: 'مصروفات مستحقة',
    nameEn: 'Accrued expenses',
    accountType: 'liability',
    parentId: '7',
  }),
];

const link = (patch: Partial<AccountLink>): AccountLink => ({
  key: 'ar_control',
  accountId: '5',
  requiredType: 'asset',
  needsControl: true,
  rowVersion: 2,
  ...patch,
});

const DATA: AccountsResponse = {
  accounts: ACCOUNTS,
  links: [
    link({ key: 'vat_output', accountId: '8', requiredType: 'liability', needsControl: false }),
    link({}),
  ],
};

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
    .on('GET', '/api/v1/accounts', ok(DATA));
}

async function openAccounting(bridge: FakeBridge) {
  render(<App bridge={bridge} />);
  await screen.findByRole('heading', { level: 1 });
  fireEvent.change(screen.getByLabelText('اسم المستخدم'), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'blue-pool-water' } });
  fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
  await screen.findByRole('heading', { name: 'أهلًا، محمد ياسر' });
  fireEvent.click(screen.getByRole('link', { name: 'المحاسبة' }));
  await screen.findByRole('heading', { name: 'المحاسبة', level: 1 });
}

const MANAGER = ['ledger.view', 'accounts.manage'];

const accountRow = (code: string) => screen.findByTestId(`account-${code}`);

describe('Accounting → Chart of accounts', () => {
  it('warns that the chart is provisional and shows it as a tree', async () => {
    await openAccounting(signedInBridge(['ledger.view']));
    expect(screen.getByText(/حتى يوافق عليهما محاسب أرتيبول/)).toBeTruthy();
    await accountRow('1000');
    const rows = screen.getAllByTestId(/^account-/);
    expect(rows.map((r) => r.dataset.testid?.replace('account-', ''))).toEqual([
      '1000',
      '1100',
      '1110',
      '1200',
      '1210',
      '1230',
      '1240',
      '1250',
      '2000',
      '2130',
      '2140',
    ]);
    const depth = (code: string) =>
      (
        within(screen.getByTestId(`account-${code}`)).getAllByRole('cell')[1]!
          .firstChild as HTMLElement
      ).style.getPropertyValue('--depth');
    expect([depth('1000'), depth('1200'), depth('1210')]).toEqual(['0', '1', '2']);
    expect(within(screen.getByTestId('account-1000')).getByText('رئيسي')).toBeTruthy();
    expect(within(screen.getByTestId('account-1210')).getByText('مراقبة')).toBeTruthy();
    // Without accounts.manage: nothing to change.
    expect(screen.queryByRole('button', { name: 'حساب جديد' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'تعديل 1230' })).toBeNull();
  });

  it('filters by code or name', async () => {
    await openAccounting(signedInBridge(['ledger.view']));
    await accountRow('1000');
    fireEvent.change(screen.getByRole('searchbox', { name: 'ابحث بالرقم أو الاسم' }), {
      target: { value: 'vat' },
    });
    expect(screen.getAllByTestId(/^account-/).map((r) => r.dataset.testid)).toEqual([
      'account-2130',
    ]);
  });

  it('an account in use says why and cannot be deactivated', async () => {
    await openAccounting(signedInBridge(MANAGER));
    const used = await accountRow('1210');
    expect(within(used).getByText('مستخدم في حسابات العمليات')).toBeTruthy();
    expect(within(used).queryByRole('button', { name: 'إيقاف 1210' })).toBeNull();
    const free = await accountRow('1230');
    expect(within(free).getByRole('button', { name: 'إيقاف 1230' })).toBeTruthy();
    expect(
      within(await accountRow('1240')).getByRole('button', { name: 'إعادة التفعيل' }),
    ).toBeTruthy();

    fireEvent.click(within(used).getByRole('button', { name: 'تعديل 1210' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/هذا الحساب مستخدم \(مستخدم في حسابات العمليات\)/),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText('النوع')).toHaveProperty('disabled', true);
  });

  it('creates an account under a header: only active headers of the same type are offered', async () => {
    const bridge = signedInBridge(MANAGER);
    bridge.on('POST', '/api/v1/accounts', ok(account({ id: '12', code: '1260' }), 201));
    await openAccounting(bridge);
    await accountRow('1000');
    fireEvent.click(screen.getByRole('button', { name: 'حساب جديد' }));
    const dialog = await screen.findByRole('dialog');
    const parent = within(dialog).getByLabelText('تحت الحساب الرئيسي');
    expect(
      within(parent)
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(['', '1', '2', '4']);
    fireEvent.change(within(dialog).getByLabelText(/^الرقم/), { target: { value: '1260' } });
    fireEvent.change(within(dialog).getByLabelText(/^الاسم بالعربية/), {
      target: { value: 'سلف الموردين' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^الاسم بالإنجليزية/), {
      target: { value: 'Supplier advances' },
    });
    fireEvent.change(parent, { target: { value: '4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    await waitFor(() => expect(bridge.callsTo('POST', '/api/v1/accounts')).toHaveLength(1));
    expect(bridge.callsTo('POST', '/api/v1/accounts')[0]!.body).toEqual({
      code: '1260',
      nameAr: 'سلف الموردين',
      nameEn: 'Supplier advances',
      accountType: 'asset',
      parentId: '4',
      isPostable: true,
      isControl: false,
      isContra: false,
    });
  });

  it('shows the translated rule when the server refuses', async () => {
    const bridge = signedInBridge(MANAGER);
    bridge.on(
      'PATCH',
      '/api/v1/accounts/6',
      failure(422, 'RULE_VIOLATION', { rule: 'ACCOUNT_PARENT_TYPE' }),
    );
    await openAccounting(bridge);
    fireEvent.click(within(await accountRow('1230')).getByRole('button', { name: 'تعديل 1230' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(
      await within(dialog).findByText('الحساب الفرعي يجب أن يكون من نفس نوع الحساب الرئيسي.'),
    ).toBeTruthy();
    expect(bridge.callsTo('PATCH', '/api/v1/accounts/6')[0]!.body).toMatchObject({
      parentId: '4',
      rowVersion: 1,
    });
  });
});

describe('Accounting → Event links', () => {
  it('offers only suitable accounts and sends { accountId, rowVersion }', async () => {
    const bridge = signedInBridge(MANAGER);
    bridge.on('PATCH', '/api/v1/account-links/ar_control', ok(link({ accountId: '11' })));
    await openAccounting(bridge);
    fireEvent.click(await screen.findByRole('tab', { name: 'حسابات العمليات' }));
    const row = await screen.findByTestId('link-ar_control');
    expect(within(row).getByText('ذمم العملاء')).toBeTruthy();
    expect(within(row).getByText('أصول · حساب مراقبة')).toBeTruthy();
    const select = within(row).getByLabelText('الحساب لـ: ذمم العملاء');
    // Active, postable asset accounts marked as control: not headers, not 1230, not the
    // deactivated 1240.
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(['5', '11']);
    const save = within(row).getByRole('button', { name: 'حفظ الحساب لـ: ذمم العملاء' });
    expect(save).toHaveProperty('disabled', true);

    fireEvent.change(select, { target: { value: '11' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(bridge.callsTo('PATCH', '/api/v1/account-links/ar_control')).toHaveLength(1),
    );
    expect(bridge.callsTo('PATCH', '/api/v1/account-links/ar_control')[0]!.body).toEqual({
      accountId: '11',
      rowVersion: 2,
    });

    // VAT payable needs a liability that is not a control account.
    const vat = screen.getByTestId('link-vat_output');
    expect(
      within(within(vat).getByRole('combobox'))
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(['8', '9']);
  });

  it('a refused link shows the translated rule', async () => {
    const bridge = signedInBridge(MANAGER);
    bridge.on(
      'PATCH',
      '/api/v1/account-links/vat_output',
      failure(422, 'RULE_VIOLATION', { rule: 'MAPPING_ACCOUNT_INVALID' }),
    );
    await openAccounting(bridge);
    fireEvent.click(await screen.findByRole('tab', { name: 'حسابات العمليات' }));
    const row = await screen.findByTestId('link-vat_output');
    fireEvent.change(within(row).getByRole('combobox'), { target: { value: '9' } });
    fireEvent.click(within(row).getByRole('button', { name: /^حفظ الحساب/ }));
    expect(
      await within(row).findByText(
        'هذه العملية تحتاج حسابًا مفعّلًا من النوع المناسب ويقبل القيود.',
      ),
    ).toBeTruthy();
  });

  it('is read-only without accounts.manage', async () => {
    await openAccounting(signedInBridge(['ledger.view']));
    fireEvent.click(await screen.findByRole('tab', { name: 'حسابات العمليات' }));
    const row = await screen.findByTestId('link-ar_control');
    expect(within(row).queryByRole('combobox')).toBeNull();
    expect(within(row).getByText('1210 · ذمم العملاء')).toBeTruthy();
  });
});
