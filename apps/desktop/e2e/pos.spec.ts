/**
 * The point of sale (M5) against the real server, on the POS PC, in Arabic and English. A cashier
 * signs in with the PIN and opens the shift with 500; scans a barcode and sells two pieces for
 * cash (change given, POS- receipt); sells beyond stock with the supervisor's phone code (the oversell
 * adjustment is pending review); then closes the shift with a blind count that is short, recounts
 * with the supervisor, and the Z report shows both counts.
 */
import { control, expect, snap, test, unique } from './fixtures';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

type T = (key: string, values?: Record<string, string | number>) => string;

async function pinSignIn(page: Page, name: string) {
  await page.getByRole('button', { name }).click();
  await page.keyboard.type('4829');
}

/** The supervisor approves with the code shown now on their phone (decision 0074). */
async function approve(page: Page, t: T, supervisor: string, supervisorId: string) {
  const dialog = page.getByRole('dialog').last();
  await dialog
    .getByLabel(t('masterdata:approval.approver'), { exact: true })
    .selectOption({ label: supervisor });
  await dialog.getByLabel(t('masterdata:approval.code')).fill(await control.codeFor(supervisorId));
  await dialog.getByLabel(t('masterdata:approval.reason')).fill('Checked at the counter');
  await dialog.getByRole('button', { name: t('masterdata:approval.approve') }).click();
}

test('sell, oversell with approval, close the shift with a recount', async ({
  page,
  open,
  t,
  lang,
}) => {
  const n = `${Date.now() % 100000}`.padStart(5, '0');
  const cashier = lang === 'ar' ? `كاشير ${n}` : `Cashier ${n}`;
  const supervisor = lang === 'ar' ? `مشرف ${n}` : `Supervisor ${n}`;
  await control.addUser({
    username: unique('cashier'),
    method: 'pin',
    pin: '4829',
    roles: ['cashier'],
    displayNameAr: `كاشير ${n}`,
    displayNameEn: `Cashier ${n}`,
  });
  const { id: supervisorId } = await control.addTwoStepUser({
    username: unique('supervisor'),
    password: 'supervisor-pool-water',
    recoveryCodes: [],
    displayNameAr: `مشرف ${n}`,
    displayNameEn: `Supervisor ${n}`,
  });
  const barcode = `629${n}0001`;
  await control.addPosItem({
    code: `TAB-${n}`,
    nameAr: `كلور أقراص ${n}`,
    nameEn: `Chlorine tablets ${n}`,
    barcode,
    price4dp: '1260000', // 126.00 with VAT
    quantityMilli: '3000',
  });

  await open('pos');
  await pinSignIn(page, cashier);
  await page.getByRole('link', { name: t('settings:nav.pos') }).click();

  // Open the shift with a float of 500.
  await page.getByLabel(t('pos:shiftOpen.float')).fill('500');
  await snap(page, '50-pos-open-shift');
  await page.getByRole('button', { name: t('pos:shiftOpen.open') }).click();

  // Scan the barcode twice: one line of two pieces (252.00).
  const search = page.getByRole('textbox', { name: t('pos:search') });
  for (let i = 0; i < 2; i += 1) {
    await search.fill(barcode);
    await expect(page.getByRole('button', { name: new RegExp(`TAB-${n}`) })).toBeVisible();
    await search.press('Enter');
  }
  await expect(page.getByLabel(t('pos:cart')).getByText('252.00').first()).toBeVisible();
  await snap(page, '51-pos-cart');

  // Pay 300 in cash: 48.00 change; the receipt is shown (no printer in the test browser).
  await page.getByRole('button', { name: new RegExp(t('pos:pay')) }).click();
  const pay = page.getByRole('dialog', { name: t('pos:payment.title') });
  await pay.getByLabel(t('pos:payment.tendered')).fill('300');
  await expect(pay.getByText('48.00')).toBeVisible();
  await snap(page, '52-pos-payment');
  await pay.getByRole('button', { name: new RegExp(t('pos:payment.confirm')) }).click();
  await expect(page.getByTestId('pos-receipt-number')).toHaveText(/^POS-/);
  await expect(page.getByRole('img', { name: t('pos:done.preview') })).toBeVisible();
  await snap(page, '53-pos-done');
  await page.getByRole('button', { name: new RegExp(t('pos:done.newSale')) }).click();

  // One piece is left: selling two needs the supervisor (decision 0003).
  await search.fill(barcode);
  await expect(page.getByRole('button', { name: new RegExp(`TAB-${n}`) })).toBeVisible();
  await search.press('Enter');
  await search.fill(barcode);
  await search.press('Enter');
  await page.getByRole('button', { name: new RegExp(t('pos:pay')) }).click();
  await page
    .getByRole('dialog', { name: t('pos:payment.title') })
    .getByRole('button', { name: new RegExp(t('pos:payment.confirm')) })
    .click();
  await expect(
    page.getByRole('dialog', { name: t('pos:approval.pos.oversell.title') }),
  ).toBeVisible();
  await snap(page, '54-pos-oversell');
  await approve(page, t, supervisor, supervisorId);
  await expect(page.getByText(/ADJ-/)).toBeVisible();
  await page.getByRole('button', { name: new RegExp(t('pos:done.newSale')) }).click();

  // Close: expected 500 + 252 + 252 = 1,004.00. Count 1,000 (short 4.00), recount with approval.
  await page.getByRole('link', { name: t('pos:shift'), exact: true }).click();
  await expect(page.getByRole('button', { name: t('pos:shiftPage.close') })).toBeVisible();
  await snap(page, '57-pos-shift-page');
  await page.getByRole('button', { name: t('pos:shiftPage.close') }).click();
  const close = page.getByRole('dialog');
  await expect(close.getByText(t('pos:closeShift.expected'), { exact: true })).toHaveCount(0);
  await close.getByLabel(t('pos:closeShift.countOf', { value: '100.00' })).fill('10');
  await snap(page, '55-pos-blind-count');
  await close.getByRole('button', { name: t('pos:closeShift.saveCount') }).click();
  await expect(close.getByTestId('variance')).toHaveText('-4.00');
  await close.getByRole('button', { name: t('pos:closeShift.recount') }).click();
  await close.getByLabel(t('pos:closeShift.countOf', { value: '100.00' })).fill('10');
  await close.getByLabel(t('pos:closeShift.other')).fill('4');
  await close.getByRole('button', { name: t('pos:closeShift.saveCount') }).click();
  await approve(page, t, supervisor, supervisorId);
  await expect(close.getByTestId('variance')).toHaveText('0.00');
  await close.getByRole('button', { name: t('pos:closeShift.close') }).click();

  const z = page.getByTestId('shift-report');
  await expect(z.getByText(t('pos:report.recount'))).toBeVisible();
  await expect(z.getByText('1,000.00').first()).toBeVisible();
  await expect(z.getByText('1,004.00').first()).toBeVisible();
  await snap(page, '56-pos-z-report');
});
