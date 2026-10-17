/**
 * A stuck shift (decision 0069): a cashier's shift is open on a PC where it can no longer be
 * closed. The owner closes it from the office PC with a reason and a count of its drawer; the
 * 50.00 short stays the cashier's and waits for acceptance as usual.
 */
import { control, expect, signInAsOwner, snap, test } from './fixtures';

test.setTimeout(120_000);

test('the owner closes a stuck shift from another PC', async ({ page, open, t, lang }) => {
  const n = `${Date.now() % 100000}`.padStart(5, '0');
  const { shiftNumber } = await control.stuckShift({
    code: `OLD-POS-${lang}-${n}`,
    username: `stuck.${lang}.${n}`,
    displayName: `Cashier ${n}`,
    floatFils: '50000',
  });
  await open('office');
  await signInAsOwner(page, t);
  await page.getByRole('link', { name: t('settings:nav.shifts') }).click();
  const row = page.getByRole('row').filter({ hasText: shiftNumber });
  await row.getByRole('button', { name: t('pos:shifts.forceClose') }).click();
  const dialog = page.getByRole('dialog');
  // A reason is required.
  await dialog.getByRole('button', { name: t('pos:shifts.forceClose') }).click();
  await expect(dialog.getByText(t('pos:shifts.noteRequired'))).toBeVisible();
  await dialog.getByLabel(t('pos:shifts.forceCloseReason')).fill('The PC was enrolled again');
  await dialog.getByLabel(t('pos:closeShift.countOf', { value: '100.00' })).fill('4');
  await dialog.getByLabel(t('pos:closeShift.other')).fill('50');
  await snap(page, '80-stuck-shift-close');
  await dialog.getByRole('button', { name: t('pos:shifts.forceClose') }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByText(t('pos:shifts.forceClosed'))).toBeVisible();
  await expect(row.getByText('-50.00')).toBeVisible();
  await expect(row.getByRole('button', { name: t('pos:shifts.accept') })).toBeVisible();
  await snap(page, '81-stuck-shift-closed');
});
