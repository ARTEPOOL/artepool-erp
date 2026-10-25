/**
 * The owner dashboard (decision 0081) against the real server: the owner opens it from the side
 * menu, switches the period, and sees the four figures and the "right now" tiles.
 */
import { expect, signInAsOwner, snap, test } from './fixtures';

test('the owner opens the dashboard and switches the period', async ({ page, open, t }) => {
  await open('office');
  await signInAsOwner(page, t);
  await page.getByRole('link', { name: t('settings:nav.reports') }).click();
  await expect(page.getByRole('heading', { name: t('settings:dashboard.title') })).toBeVisible();
  for (const key of ['total', 'net', 'vat', 'profit'] as const) {
    await expect(page.getByText(t(`settings:dashboard.${key}`)).first()).toBeVisible();
  }
  await page
    .getByRole('group', { name: t('settings:dashboard.period') })
    .getByRole('button', { name: t('settings:dashboard.periods.month') })
    .click();
  await expect(page.getByText(t('settings:dashboard.safe'))).toBeVisible();
  await snap(page, '80-owner-dashboard');
});
