/**
 * The print designer (M4b) against the real server, in Arabic and English: the owner adds a bank
 * account (a wrong IBAN is refused), changes the A4 invoice's colour and turns on the amount in
 * words and the bank details, saves a new version, then sets the thermal receipt to English on
 * 58 mm paper. The required tax fields are listed and cannot be switched off.
 */
import { control, expect, signInAsOwner, snap, test } from './fixtures';
import type { Locator } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

async function turnOn(toggle: Locator) {
  if (!(await toggle.isChecked())) await toggle.locator('xpath=ancestor::label[1]').click();
  await expect(toggle).toBeChecked();
}

test('bank account, A4 invoice design, thermal receipt design', async ({ page, open, t, lang }) => {
  const n = `${Date.now() % 100000}`.padStart(5, '0');
  // The company details exist (the preview prints them).
  await control.addPosItem({
    code: `PD-${n}`,
    nameAr: `صنف ${n}`,
    nameEn: `Item ${n}`,
    barcode: `628${n}0001`,
    price4dp: '1050000',
    quantityMilli: '1000',
  });
  await open('office');
  await signInAsOwner(page, t);
  await page.getByRole('link', { name: t('settings:nav.settings') }).click();

  // A bank account: a wrong IBAN is refused, the right one is saved without spaces.
  await page.getByRole('link', { name: t('settings:hub.company') }).click();
  await page.getByRole('button', { name: t('setup:company.bank.add') }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(t('setup:company.bank.bankName')).fill('Emirates NBD');
  await dialog.getByLabel(t('setup:company.bank.accountName')).fill('ARTEPOOL Swimming Pools');
  const iban = dialog.getByLabel(t('setup:company.bank.iban'));
  await iban.fill('AE07 0331 2345 6789 0123 457');
  await dialog.getByRole('button', { name: t('setup:company.bank.save') }).click();
  await expect(dialog.getByText(t('setup:company.bank.ibanRule'))).toBeVisible();
  // Each project adds its own account (an active IBAN is unique).
  const good = lang === 'ar' ? 'AE07 0331 2345 6789 0123 456' : 'AE20 0330 0000 1012 3456 787';
  await iban.fill(good);
  await dialog.getByRole('button', { name: t('setup:company.bank.save') }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(good).first()).toBeVisible();
  await snap(page, '70-company-bank-accounts');

  // The A4 invoice: required fields listed; colour, amount in words, bank details; save.
  await page.getByRole('link', { name: t('settings:hub.print') }).click();
  await expect(page.getByRole('heading', { name: t('settings:print.title') })).toBeVisible();
  await expect(
    page
      .getByRole('list', { name: t('settings:print.requiredLabel') })
      .getByText(t('settings:print.locked.sellerAddressTrn')),
  ).toBeVisible();
  await expect(page.locator('iframe')).toBeVisible();
  // A colour of each project's own, so each run has something to save.
  await page.locator('input[type="color"]').fill(lang === 'ar' ? '#0a5c8a' : '#7a2e8c');
  await turnOn(page.getByRole('switch', { name: t('settings:print.fields.amountInWords') }));
  await turnOn(page.getByRole('switch', { name: t('settings:print.fields.bankDetails') }));
  await page.getByLabel(t('settings:print.bankAccount')).selectOption({ index: 1 });
  await expect(page.getByText(t('settings:print.unsaved'))).toBeVisible();
  await page.waitForTimeout(800); // the preview refreshes shortly after a change
  await snap(page, '71-print-designer-a4');
  await page.getByRole('button', { name: t('settings:print.save'), exact: true }).click();
  await expect(page.getByText(t('settings:print.unsaved'))).toHaveCount(0);

  // The thermal receipt, previewed as the POS draws it: each run makes a change of its own
  // (Arabic run: English on 58 mm; English run: Arabic on 80 mm).
  const [language, width] = lang === 'ar' ? (['en', '58'] as const) : (['ar', '80'] as const);
  await page.getByRole('tab', { name: t('settings:print.kinds.receipt_thermal') }).click();
  await page
    .getByRole('switch', { name: t('settings:print.fullSample') })
    .locator('xpath=ancestor::label[1]')
    .click();
  const main = page.getByRole('main');
  await main
    .getByRole('group', { name: t('settings:print.language') })
    .getByRole('button', { name: t(`settings:print.languages.${language}`), exact: true })
    .click();
  await main.getByRole('button', { name: t(`settings:print.widths.${width}`) }).click();
  await expect(page.getByRole('img', { name: t('settings:print.previewAlt') })).toHaveAttribute(
    'data-width',
    width,
  );
  await snap(page, '72-print-designer-receipt');
  await page.getByRole('button', { name: t('settings:print.save'), exact: true }).click();
  await expect(page.getByText(t('settings:print.unsaved'))).toHaveCount(0);
});
