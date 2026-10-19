/** Quick PIN sign-in, only on POS PCs (decision 0021), and the lock screen. */
import { accountMenu, control, expect, snap, test, unique } from './fixtures';

test('a cashier picks their name and enters the PIN; the lock screen takes them back', async ({
  page,
  open,
  t,
  lang,
}) => {
  const suffix = Math.floor(Math.random() * 9000 + 1000);
  const name = lang === 'ar' ? `أحمد ${suffix}` : `Ahmed ${suffix}`;
  await control.addUser({
    username: unique('ahmed'),
    method: 'pin',
    pin: '4829',
    displayNameAr: `أحمد ${suffix}`,
    displayNameEn: `Ahmed ${suffix}`,
  });
  await open('pos');
  await expect(page.getByRole('heading', { name: t('auth:pin.title') })).toBeVisible();
  await page.getByRole('button', { name }).click();
  await snap(page, '10-pin');

  for (const digit of ['1', '1', '1', '2']) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await expect(page.getByText(t('common:errors.INVALID_PIN'))).toBeVisible();
  await snap(page, '11-pin-wrong');

  await page.keyboard.type('4829'); // digits from the keyboard work too
  await expect(page.getByRole('button', { name: t('settings:user.menu') })).toBeVisible();

  await accountMenu(page, t, 'lock');
  await expect(page.getByRole('heading', { name: t('auth:lock.title') })).toBeVisible();
  await snap(page, '12-locked');
  await page.getByLabel(t('auth:signIn.pin'), { exact: true }).fill('4829');
  await page.getByRole('button', { name: t('auth:lock.unlock'), exact: true }).click();
  await expect(page.getByRole('button', { name: t('settings:user.menu') })).toBeVisible();
  await accountMenu(page, t, 'signOut');
});

test('a temporary PIN must be changed at first sign-in; weak PINs are refused', async ({
  page,
  open,
  t,
  lang,
}) => {
  const suffix = Math.floor(Math.random() * 9000 + 1000);
  await control.addUser({
    username: unique('yousef'),
    method: 'pin',
    pin: '5017',
    mustChange: true,
    displayNameAr: `يوسف ${suffix}`,
    displayNameEn: `Yousef ${suffix}`,
  });
  await open('pos');
  await page
    .getByRole('button', { name: lang === 'ar' ? `يوسف ${suffix}` : `Yousef ${suffix}` })
    .click();
  await page.keyboard.type('5017');
  await expect(page.getByRole('heading', { name: t('auth:change.pinTitle') })).toBeVisible();
  await page.getByLabel(t('auth:change.newPin'), { exact: true }).fill('1234');
  await page.getByLabel(t('auth:change.again'), { exact: true }).fill('1234');
  await page.getByRole('button', { name: t('auth:change.save') }).click();
  await expect(page.getByText(t('auth:change.problems.weak'))).toBeVisible();
  await page.getByLabel(t('auth:change.newPin'), { exact: true }).fill('7391');
  await page.getByLabel(t('auth:change.again'), { exact: true }).fill('7391');
  await page.getByRole('button', { name: t('auth:change.save') }).click();
  await expect(page.getByRole('button', { name: t('settings:user.menu') })).toBeVisible();
  await accountMenu(page, t, 'signOut');
});
