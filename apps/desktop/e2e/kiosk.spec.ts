/**
 * The POS kiosk lock (decisions 0082, 0083, 0089, 0090) against the real server, in Arabic and
 * English. On the locked POS PC, the owner's current code lifts the lock for 5 minutes and the
 * banner "Kiosk lock is off · until …" shows. On the office PC, the owner sees the POS PC's lock
 * off, turns it back on with a reason and the code, then off for 15 minutes and on again; the
 * alerts card lists the changes. A cashier locks the POS screen with the "Lock screen" button and
 * resumes with the PIN.
 */
import type { Locator, Page } from '@playwright/test';
import { control, expect, signInAsOwner, snap, test, unique } from './fixtures';

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

type T = (key: string, values?: Record<string, string | number>) => string;

async function code(page: Page, dialog: Locator, t: T, value: string) {
  await dialog.getByLabel(t('auth:secondFactor.digit', { n: 1 }), { exact: true }).focus();
  await page.keyboard.type(value);
}

async function devicesRow(page: Page, t: T): Promise<Locator> {
  await page.getByRole('link', { name: t('settings:nav.settings') }).click();
  await page.getByRole('link', { name: t('settings:hub.devices') }).click();
  return page.getByRole('row').filter({ hasText: 'COUNTER-01' });
}

/** The owner turns the POS PC's kiosk lock on, or off for 15 minutes, from the office PC. */
async function change(page: Page, t: T, row: Locator, turnOn: boolean) {
  await row
    .getByRole('button', {
      name: turnOn ? t('settings:devices.kiosk.turnOn') : t('settings:devices.kiosk.turnOff'),
    })
    .click();
  const dialog = page.getByRole('dialog');
  if (!turnOn)
    await dialog.getByRole('button', { name: t('settings:devices.kiosk.minutes15') }).click();
  await dialog.getByLabel(t('settings:devices.kiosk.reason'), { exact: true }).fill('Printer');
  await code(page, dialog, t, await control.ownerCode());
  await dialog
    .getByRole('button', {
      name: turnOn ? t('settings:devices.kiosk.turnOn') : t('settings:devices.kiosk.turnOff'),
    })
    .click();
  await expect(dialog).toBeHidden();
}

test('unlock with the owner code on the POS PC, then manage the lock from the office', async ({
  page,
  open,
  t,
}) => {
  await open('pos');
  await page.getByRole('button', { name: t('auth:kiosk.ownerCode') }).click();
  const dialog = page.getByRole('dialog');
  await code(page, dialog, t, await control.ownerCode());
  await dialog.getByRole('button', { name: t('auth:kiosk.unlock'), exact: true }).click();
  const banner = page.getByTestId('kiosk-off');
  await expect(banner).toContainText(t('auth:kiosk.off'));
  await expect(banner).toContainText(t('auth:kiosk.until', { time: '' }).trim());
  await snap(page, '90-kiosk-off-banner');

  await open('office');
  await signInAsOwner(page, t);
  let row = await devicesRow(page, t);
  await expect(row).toContainText(t('settings:devices.kiosk.offUntil', { time: '' }).trim());
  await change(page, t, row, true);
  await expect(row).toContainText(t('settings:devices.kiosk.on'));

  await change(page, t, row, false);
  await expect(row).toContainText(t('settings:devices.kiosk.offUntil', { time: '' }).trim());
  await expect(page.getByTestId('kiosk-alerts')).toContainText(
    t('settings:devices.kiosk.alert.offFor', { minutes: 15 }),
  );
  await snap(page, '91-kiosk-lock-settings');
  row = page.getByRole('row').filter({ hasText: 'COUNTER-01' });
  await change(page, t, row, true);
  await expect(row).toContainText(t('settings:devices.kiosk.on'));
});

test('the cashier locks the POS screen and resumes with the PIN (0090)', async ({
  page,
  open,
  t,
  lang,
}) => {
  const n = `${Date.now() % 100000}`.padStart(5, '0');
  const cashier = lang === 'ar' ? `كاشير ${n}` : `Cashier ${n}`;
  await control.addUser({
    username: unique('cashier'),
    method: 'pin',
    pin: '4829',
    roles: ['cashier'],
    displayNameAr: `كاشير ${n}`,
    displayNameEn: `Cashier ${n}`,
  });
  await open('pos');
  // The lock is on again: no banner on the POS PC.
  await expect(page.getByTestId('kiosk-off')).toHaveCount(0);
  await page.getByRole('button', { name: cashier }).click();
  await page.keyboard.type('4829');
  await page.getByRole('link', { name: t('settings:nav.pos') }).click();
  await page.getByLabel(t('pos:shiftOpen.float')).fill('100');
  await page.getByRole('button', { name: t('pos:shiftOpen.open') }).click();
  await page.getByRole('button', { name: t('pos:lockScreen') }).click();
  await expect(page.getByRole('heading', { name: t('auth:lock.title') })).toBeVisible();
  await page.getByLabel(t('auth:signIn.pin'), { exact: true }).fill('4829');
  await page.getByRole('button', { name: t('auth:lock.unlock'), exact: true }).click();
  // Back on the sale screen of the same open shift.
  await expect(page.getByRole('button', { name: t('pos:lockScreen') })).toBeVisible();

  // Close the shift (count = the float) so the drawer is free for the other tests.
  await page.getByRole('link', { name: t('pos:shift'), exact: true }).click();
  await page.getByRole('button', { name: t('pos:shiftPage.close') }).click();
  const close = page.getByRole('dialog');
  await close.getByLabel(t('pos:closeShift.countOf', { value: '100.00' })).fill('1');
  await close.getByRole('button', { name: t('pos:closeShift.saveCount') }).click();
  await expect(close.getByTestId('variance')).toHaveText('0.00');
  await close.getByRole('button', { name: t('pos:closeShift.close') }).click();
  await expect(page.getByTestId('shift-report')).toBeVisible();
});
