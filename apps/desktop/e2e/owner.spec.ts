/** The owner's 2-step code (decision 0022): setup, daily sign-in, and a recovery code. */
import { authenticatorCode, control, expect, snap, test, typeCode } from './fixtures';

test.describe.configure({ mode: 'serial' });

let recoveryCode = '';

async function signInAsOwner(page: import('@playwright/test').Page, t: (k: string) => string) {
  const owner = await control.owner();
  await page.getByLabel(t('auth:signIn.username'), { exact: true }).fill(owner.username);
  await page.getByLabel(t('auth:signIn.password'), { exact: true }).fill(owner.password);
  await page.getByRole('button', { name: t('auth:signIn.submit') }).click();
}

test('first time: scan, confirm, and keep the 10 recovery codes shown once', async ({
  page,
  open,
  t,
}) => {
  await control.resetOwnerTwoStep();
  await open('office');
  await signInAsOwner(page, t);
  await expect(page.getByRole('heading', { name: t('auth:twoStep.title') })).toBeVisible();
  await expect(page.getByRole('img', { name: t('auth:twoStep.qrLabel') })).toBeVisible();
  const key = (await page.locator('code').innerText()).replace(/\s/g, '');
  expect(key).toMatch(/^[A-Z2-7]{32}$/);
  await snap(page, '07-two-step-setup');

  await typeCode(page, authenticatorCode(key));
  await page.getByRole('button', { name: t('auth:twoStep.confirm') }).click();
  await expect(page.getByRole('heading', { name: t('auth:recovery.title') })).toBeVisible();
  const codes = await page.getByRole('listitem').allInnerTexts();
  expect(codes).toHaveLength(10);
  recoveryCode = codes[0]!;
  await snap(page, '08-recovery-codes');

  await expect(page.getByRole('button', { name: t('auth:recovery.continue') })).toBeDisabled();
  await page.getByText(t('auth:recovery.saved')).click();
  await page.getByRole('button', { name: t('auth:recovery.continue') }).click();
  await expect(page.getByRole('button', { name: t('settings:user.menu') })).toBeVisible();
});

test('daily sign-in: a wrong code shows the design message, the right one opens the app', async ({
  page,
  open,
  t,
}) => {
  await open('office');
  await signInAsOwner(page, t);
  await expect(page.getByRole('heading', { name: t('auth:secondFactor.title') })).toBeVisible();
  await typeCode(page, '000000');
  await page.getByRole('button', { name: t('auth:secondFactor.confirm') }).click();
  await expect(page.getByText(t('common:errors.INVALID_TWO_STEP_CODE'))).toBeVisible();
  await snap(page, '09-owner-code-wrong');

  await typeCode(page, await control.ownerCode());
  await page.getByRole('button', { name: t('auth:secondFactor.confirm') }).click();
  await expect(page.getByRole('button', { name: t('settings:user.menu') })).toBeVisible();
});

test('a recovery code works once, then the 2-step code must be set up again', async ({
  page,
  open,
  t,
}) => {
  expect(recoveryCode).not.toBe('');
  await open('office');
  await signInAsOwner(page, t);
  await page.getByRole('button', { name: t('auth:secondFactor.useRecovery') }).click();
  await page.getByLabel(t('auth:secondFactor.recoveryLabel'), { exact: true }).fill(recoveryCode);
  await page.getByRole('button', { name: t('auth:secondFactor.confirm') }).click();
  await expect(page.getByRole('heading', { name: t('auth:twoStep.title') })).toBeVisible();
  await expect(page.getByText(t('auth:twoStep.again'))).toBeVisible();
});
