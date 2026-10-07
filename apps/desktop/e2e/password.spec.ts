/** Password sign-in on an office PC (design 01, decisions 0021 and 0023). */
import { accountMenu, control, expect, snap, test, unique } from './fixtures';

test('wrong password, sign in, sign out; the language switch mirrors the layout', async ({
  page,
  open,
  t,
  lang,
}) => {
  const username = unique('sara');
  await control.addUser({
    username,
    password: 'blue-pool-water-1',
    displayNameAr: 'سارة علي',
    displayNameEn: 'Sara Ali',
  });
  await open('office');
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
  await expect(page.getByRole('heading', { name: t('auth:signIn.title') })).toBeVisible();
  // Office PCs always need a password: no PIN option (decision 0021).
  await expect(page.getByRole('group', { name: t('auth:signIn.method') })).toHaveCount(0);
  await expect(page.getByText(t('shell:server.connected'))).toBeVisible();
  await snap(page, '03-sign-in');

  await page.getByLabel(t('auth:signIn.username'), { exact: true }).fill(username);
  await page.getByLabel(t('auth:signIn.password'), { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: t('auth:signIn.submit') }).click();
  await expect(page.getByText(t('common:errors.INVALID_CREDENTIALS'))).toBeVisible();
  await snap(page, '04-wrong-password');

  await page.getByLabel(t('auth:signIn.password'), { exact: true }).fill('blue-pool-water-1');
  await page.getByRole('button', { name: t('auth:signIn.submit') }).click();
  const name = lang === 'ar' ? 'سارة علي' : 'Sara Ali';
  await expect(
    page.getByRole('heading', { name: t('settings:home.welcome', { name }) }),
  ).toBeVisible();

  await accountMenu(page, t, 'signOut');
  await expect(page.getByText(t('auth:signIn.signedOut'))).toBeVisible();
  // Remembered on this PC (the checkbox is on by default).
  await expect(page.getByLabel(t('auth:signIn.username'), { exact: true })).toHaveValue(username);

  const other: 'ar' | 'en' = lang === 'ar' ? 'en' : 'ar';
  await page.getByRole('button', { name: other === 'en' ? 'English' : 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', other === 'ar' ? 'rtl' : 'ltr');
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(t('auth:signIn.title'));
});

test('five wrong passwords lock the account for 15 minutes', async ({ page, open, t }) => {
  const username = unique('locked');
  await control.addUser({ username, password: 'blue-pool-water-2' });
  await open('office');
  await page.getByLabel(t('auth:signIn.username'), { exact: true }).fill(username);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.getByLabel(t('auth:signIn.password'), { exact: true }).fill(`wrong-${attempt}`);
    await page.getByRole('button', { name: t('auth:signIn.submit') }).click();
    await expect(page.getByRole('alert')).toBeVisible();
  }
  await expect(page.getByText(t('common:errors.ACCOUNT_LOCKED', { minutes: 15 }))).toBeVisible();
  await expect(page.getByRole('button', { name: t('auth:signIn.submit') })).toBeDisabled();
  await snap(page, '05-account-locked');
});

test('first sign-in with a temporary password: the person chooses their own', async ({
  page,
  open,
  t,
}) => {
  const username = unique('newstaff');
  await control.addUser({ username, password: 'TEMP-CODE-4829', mustChange: true });
  await open('office');
  await page.getByLabel(t('auth:signIn.username'), { exact: true }).fill(username);
  await page.getByLabel(t('auth:signIn.password'), { exact: true }).fill('TEMP-CODE-4829');
  await page.getByRole('button', { name: t('auth:signIn.submit') }).click();
  await expect(page.getByRole('heading', { name: t('auth:change.passwordTitle') })).toBeVisible();

  await page.getByLabel(t('auth:change.newPassword'), { exact: true }).fill('password123');
  await page.getByLabel(t('auth:change.again'), { exact: true }).fill('password123');
  await page.getByRole('button', { name: t('auth:change.save') }).click();
  await expect(page.getByText(t('auth:change.problems.common'))).toBeVisible();
  await snap(page, '06-choose-password');

  await page
    .getByLabel(t('auth:change.newPassword'), { exact: true })
    .fill('a calm pool in al ain');
  await page.getByLabel(t('auth:change.again'), { exact: true }).fill('a calm pool in al ain');
  await page.getByRole('button', { name: t('auth:change.save') }).click();
  await expect(page.getByRole('button', { name: t('settings:user.menu') })).toBeVisible();
});

test('"Forgot your password?" explains who resets it', async ({ page, open, t }) => {
  await open('office');
  await page.getByRole('button', { name: t('auth:signIn.forgot') }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(t('auth:forgot.body'))).toBeVisible();
  await dialog.getByRole('button', { name: t('auth:forgot.ok') }).click();
  await expect(dialog).toHaveCount(0);
});
