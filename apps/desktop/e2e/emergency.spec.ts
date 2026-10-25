/**
 * "ARTÉPOOL – Emergency tool" (decision 0107) in a real browser, in Arabic and English: the window
 * runs the console's own program against a real database (a server PC right after installation,
 * before the first-run setup): the system check, a refused reset while there is no owner yet, and
 * an enrollment code.
 */
import { E2E } from './paths';
import { control, expect, snap, test } from './fixtures';

test.setTimeout(120_000);

test('the emergency tool checks the system and makes an enrollment code', async ({
  page,
  open,
  t,
}) => {
  await control.setupServer();
  await open('setup');
  await page.goto(`http://localhost:${E2E.pcs.setup.port}/?emergency`);
  await expect(page.getByRole('heading', { name: t('emergency:menu.title') })).toBeVisible({
    timeout: 30_000,
  });
  await snap(page, '110-emergency-menu');

  // The check: no Windows services here, but the database answers; no owner yet.
  await page.getByRole('button', { name: t('emergency:menu.check.open') }).click();
  await expect(page.getByText(t('emergency:check.databaseOk'))).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(t('emergency:check.ownerNone'))).toBeVisible();
  await page.getByRole('button', { name: t('emergency:back') }).click();

  // A password reset needs an owner.
  await page.getByRole('button', { name: t('emergency:menu.password.open') }).click();
  await page.getByLabel(t('emergency:reason.label')).fill('forgot the password');
  await page.getByRole('button', { name: t('emergency:password.submit') }).click();
  await expect(page.getByText(t('emergency:errors.no_owner'))).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: t('emergency:back') }).click();

  // An enrollment code, valid for 10 minutes.
  await page.getByRole('button', { name: t('emergency:menu.code.open') }).click();
  await page.getByRole('button', { name: t('emergency:code.submit') }).click();
  await expect(page.getByLabel(t('emergency:code.label'))).toHaveText(/^[0-9A-Z-]{6,}$/, {
    timeout: 30_000,
  });
  await snap(page, '111-emergency-code');
});
