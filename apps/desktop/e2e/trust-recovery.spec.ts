/**
 * "Trust this PC" for the 2-step code (decision 0027) and forgot password with the phone code
 * and one recovery code (decision 0028), against the real server.
 */
import type { Page } from '@playwright/test';
import { accountMenu, control, expect, signInAsOwner, snap, test, unique } from './fixtures';

test.describe.configure({ mode: 'serial' });

const newName = (prefix: string) =>
  unique(prefix)
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, '');

async function signIn(page: Page, t: (key: string) => string, username: string, password: string) {
  await page.getByLabel(t('auth:signIn.username'), { exact: true }).fill(username);
  await page.getByLabel(t('auth:signIn.password'), { exact: true }).fill(password);
  await page.getByRole('button', { name: t('auth:signIn.submit') }).click();
}

test('trust this PC: the phone code once, then the password alone; the owner can end it', async ({
  page,
  open,
  t,
  lang,
}) => {
  const username = newName('sara');
  const password = 'sara trusts her office pc';
  const { id } = await control.addTwoStepUser({
    username,
    password,
    displayNameAr: 'سارة الموثوقة',
    displayNameEn: 'Sara Trusted',
    recoveryCodes: [],
  });
  await open('office');
  await signIn(page, t, username, password);
  await expect(page.getByRole('heading', { name: t('auth:secondFactor.title') })).toBeVisible();
  const label = t('auth:secondFactor.trust', { days: 30 });
  const trust = page.getByRole('checkbox', { name: label });
  await expect(trust).not.toBeChecked();
  await page.getByText(label).click();
  await expect(trust).toBeChecked();
  await page.getByLabel(t('auth:secondFactor.digit', { n: 1 }), { exact: true }).click();
  await page.keyboard.type(await control.codeFor(id));
  await snap(page, '30-trust-this-pc');
  await page.getByRole('button', { name: t('auth:secondFactor.confirm') }).click();
  await expect(page.getByRole('button', { name: t('settings:user.menu') })).toBeVisible();

  // Next time on this PC: the password alone.
  await accountMenu(page, t, 'signOut');
  await signIn(page, t, username, password);
  await expect(page.getByRole('button', { name: t('settings:user.menu') })).toBeVisible();
  await accountMenu(page, t, 'signOut');

  // The owner sees it in Settings → Devices and ends it.
  await signInAsOwner(page, t);
  await page.getByRole('link', { name: t('settings:nav.settings') }).click();
  await page.getByRole('link', { name: t('settings:hub.devices') }).click();
  const name = lang === 'ar' ? 'سارة الموثوقة' : 'Sara Trusted';
  const row = page.getByRole('row', { name: /OFFICE-01/ });
  await expect(row.getByText(new RegExp(name))).toBeVisible();
  await snap(page, '31-trusted-pc');
  await row.getByRole('button', { name: t('settings:devices.endTrust') }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: t('settings:devices.endTrust') })
    .click();
  await expect(page.getByText(t('settings:devices.trustEnded'))).toBeVisible();
  await expect(row.getByText(new RegExp(name))).toHaveCount(0);

  // The phone code is asked again.
  await accountMenu(page, t, 'signOut');
  await signIn(page, t, username, password);
  await expect(page.getByRole('heading', { name: t('auth:secondFactor.title') })).toBeVisible();
});

test('forgot password: the phone code and one recovery code, then straight in', async ({
  page,
  open,
  t,
}) => {
  const username = newName('huda');
  const { id } = await control.addTwoStepUser({
    username,
    password: 'huda forgot this one',
    displayNameAr: 'هدى',
    displayNameEn: 'Huda',
    recoveryCodes: ['ABCDE-FGHJK', 'MNPQR-STUVW', 'XYZ23-45678'],
  });
  await open('office');
  await page.getByRole('button', { name: t('auth:signIn.forgot') }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: t('auth:forgot.recover') }).click();
  await expect(page.getByRole('heading', { name: t('auth:passwordRecovery.title') })).toBeVisible();

  await page.getByLabel(t('auth:signIn.username'), { exact: true }).fill(username);
  await page.getByLabel(t('auth:secondFactor.digit', { n: 1 }), { exact: true }).click();
  await page.keyboard.type(await control.codeFor(id));
  await page.getByLabel(t('auth:secondFactor.recoveryLabel'), { exact: true }).fill('abcde-fghjk');
  await page.getByLabel(t('auth:change.newPassword'), { exact: true }).fill('huda chose a new one');
  await page.getByLabel(t('auth:change.again'), { exact: true }).fill('huda chose a new one');
  await snap(page, '32-recover-password');
  await page.getByRole('button', { name: t('auth:passwordRecovery.save') }).click();

  await expect(
    page.getByRole('heading', { name: t('auth:passwordRecovery.doneTitle') }),
  ).toBeVisible();
  await expect(page.getByText(t('auth:passwordRecovery.left', { count: 2 }))).toBeVisible();
  await snap(page, '33-password-recovered');
  await page.getByRole('button', { name: t('auth:passwordRecovery.continue') }).click();
  await expect(page.getByRole('button', { name: t('settings:user.menu') })).toBeVisible();

  // The new password works; the old one does not.
  await accountMenu(page, t, 'signOut');
  await signIn(page, t, username, 'huda forgot this one');
  await expect(page.getByText(t('common:errors.INVALID_CREDENTIALS'))).toBeVisible();
  await signIn(page, t, username, 'huda chose a new one');
  await expect(page.getByRole('heading', { name: t('auth:secondFactor.title') })).toBeVisible();
});
