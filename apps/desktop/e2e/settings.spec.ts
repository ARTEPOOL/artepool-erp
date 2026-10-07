/**
 * Settings (design 13) against the real server: a new user's temporary code is shown once; a
 * user is deactivated and a PC revoked, each with a reason; both appear in the audit log with
 * what changed. Someone without the permissions never sees Settings.
 */
import { accountMenu, control, expect, signInAsOwner, snap, test, unique } from './fixtures';

test.describe.configure({ mode: 'serial' });

test('the owner creates a user, then deactivates them with a reason', async ({
  page,
  open,
  t,
  lang,
}) => {
  const username = unique('ali')
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, '');
  const reason = `left the company ${username}`;
  await open('office');
  await signInAsOwner(page, t);
  await page.getByRole('link', { name: t('settings:nav.settings') }).click();
  await expect(page.getByRole('heading', { name: t('settings:users.title') })).toBeVisible();
  await snap(page, '20-settings-users');

  await page.getByRole('button', { name: t('settings:users.newUser') }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(t('settings:newUser.nameAr'), { exact: true }).fill('علي حسن');
  await dialog.getByLabel(t('settings:newUser.nameEn'), { exact: true }).fill('Ali Hassan');
  await dialog.getByLabel(t('settings:newUser.username'), { exact: true }).fill(username);
  await snap(page, '21-new-user');
  await dialog.getByRole('button', { name: t('settings:newUser.create') }).click();
  const code = page.getByTestId('temporary-code');
  await expect(code).toHaveText(/^\d{4}$/); // a cashier gets a temporary PIN
  await snap(page, '22-temporary-code');
  await page.getByRole('button', { name: t('settings:common.done') }).click();
  await expect(code).toHaveCount(0);

  const name = lang === 'ar' ? 'علي حسن' : 'Ali Hassan';
  await page
    .getByRole('row', { name: new RegExp(name) })
    .first()
    .click();
  await page.getByRole('button', { name: t('settings:users.deactivate') }).click();
  const confirm = page.getByRole('dialog');
  await confirm.getByLabel(t('settings:common.reason'), { exact: true }).fill(reason);
  await confirm.getByRole('button', { name: t('settings:deactivate.confirm') }).click();
  await expect(page.getByText(t('settings:users.deactivated'))).toBeVisible();
  await expect(page.getByText(t('settings:users.deactivatedBy', { reason }))).toBeVisible();

  await page.getByRole('link', { name: t('settings:hub.audit') }).click();
  await page.getByLabel(t('settings:audit.search')).fill(reason);
  await page
    .getByRole('row', { name: new RegExp(t('settings:audit.tables.auth.users.update')) })
    .first()
    .click();
  await expect(page.getByText(t('settings:audit.fields.deactivation_reason'))).toBeVisible();
  await expect(page.locator('bdi', { hasText: reason }).first()).toBeVisible();
  await snap(page, '23-audit-before-after');
});

test('the owner revokes a PC with a reason; it shows in the audit log', async ({
  page,
  open,
  t,
  lang,
}) => {
  const deviceCode = `OLD-LAPTOP-${lang.toUpperCase()}`;
  const reason = `stolen ${deviceCode}`;
  await control.addDevice(deviceCode, 'Old laptop');
  await open('office');
  await signInAsOwner(page, t);
  await page.getByRole('link', { name: t('settings:nav.settings') }).click();
  await page.getByRole('link', { name: t('settings:hub.devices') }).click();
  const row = page.getByRole('row', { name: new RegExp(deviceCode) });
  await expect(page.getByRole('row', { name: /OFFICE-01/ })).toContainText(
    t('settings:devices.thisDevice'),
  );
  await row.getByRole('button', { name: t('settings:devices.revoke') }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(t('settings:common.reason'), { exact: true }).fill(reason);
  await snap(page, '24-revoke-device');
  await dialog.getByRole('button', { name: t('settings:devices.revokeConfirm') }).click();
  await expect(row).toContainText(t('settings:devices.revoked'));

  await page.getByRole('link', { name: t('settings:hub.audit') }).click();
  await page.getByLabel(t('settings:audit.search')).fill(reason);
  await page
    .getByRole('row', { name: new RegExp(t('settings:audit.tables.auth.devices.update')) })
    .first()
    .click();
  await expect(page.getByText(t('settings:audit.fields.revoke_reason'))).toBeVisible();
  await snap(page, '25-audit-device');
  await accountMenu(page, t, 'signOut');
});

test('someone without the permissions never sees Settings', async ({ page, open, t }) => {
  const username = unique('khaled');
  await control.addUser({ username, password: 'blue-pool-water-3', roles: ['technician'] });
  await open('office');
  await page.getByLabel(t('auth:signIn.username'), { exact: true }).fill(username);
  await page.getByLabel(t('auth:signIn.password'), { exact: true }).fill('blue-pool-water-3');
  await page.getByRole('button', { name: t('auth:signIn.submit') }).click();
  await expect(page.getByRole('button', { name: t('settings:user.menu') })).toBeVisible();
  await expect(page.getByRole('link', { name: t('settings:nav.settings') })).toHaveCount(0);
  await expect(page.getByRole('button', { name: t('settings:home.openSettings') })).toHaveCount(0);
});
