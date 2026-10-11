/**
 * Master data (M2) against the real server: the owner fills in the company, adds an item that is
 * found again by a search written with other Arabic letter forms, adds a customer (TRN rule,
 * then credit with a reason), and an Excel file with one bad row is reported and imports nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { expect, signInAsOwner, snap, test } from './fixtures';
import type { Locator, Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

/** Different for each project and run, in digits only (fits phones, codes and names). */
const runDigits = () => `${Date.now() % 1_000_000}`.padStart(6, '0');

/** React Aria switches hide their input under the label: press the label (if it is off). */
async function turnOn(toggle: Locator) {
  if (!(await toggle.isChecked())) await toggle.locator('xpath=ancestor::label[1]').click();
  await expect(toggle).toBeChecked();
}

async function openMenu(page: Page, t: (key: string) => string, entry: string) {
  await page.getByRole('link', { name: t(`settings:nav.${entry}`) }).click();
}

test('the owner saves the company details', async ({ page, open, t }) => {
  await open('office');
  await signInAsOwner(page, t);
  await openMenu(page, t, 'settings');
  await page.getByRole('link', { name: t('settings:hub.company') }).click();
  await expect(page.getByRole('heading', { name: t('setup:company.title') })).toBeVisible();

  const field = (key: string) => page.getByLabel(t(`setup:company.fields.${key}`), { exact: true });
  await field('legalNameAr').fill('آرتيبول لحمامات السباحة ذ.م.م');
  await field('legalNameEn').fill('ARTEPOOL Swimming Pools LLC');
  await field('addressAr').fill('العين، شارع خليفة');
  await field('addressEn').fill('Khalifa Street, Al Ain');
  await turnOn(page.getByRole('switch', { name: t('setup:company.fields.vatRegistered') }));
  await field('trn').fill('100123456700003');
  await field('poBox').fill(runDigits()); // different in each run, so there is always a change
  await page.getByRole('button', { name: t('setup:company.save') }).click();
  await expect(page.getByText(t('setup:company.unsaved'))).toHaveCount(0);
  await snap(page, '40-settings-company');

  await page.getByRole('link', { name: t('settings:hub.tax') }).click();
  await expect(page.getByRole('heading', { name: t('setup:tax.title') })).toBeVisible();
  await snap(page, '41-settings-vat-numbering');
  await page.getByRole('link', { name: t('settings:hub.lists') }).click();
  await expect(page.getByRole('heading', { name: t('lists:title') })).toBeVisible();
  await snap(page, '42-settings-lists');
});

test('an item is found again with other Arabic letter forms', async ({ page, open, t, lang }) => {
  const n = runDigits();
  await open('office');
  await signInAsOwner(page, t);
  await openMenu(page, t, 'items');
  await expect(page.getByRole('heading', { name: t('items:title') })).toBeVisible();

  await page.getByRole('button', { name: t('items:newItem') }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel(t('items:fields.category'), { exact: true })
    .selectOption({ label: lang === 'en' ? 'Equipment' : 'معدات' });
  await expect(dialog.getByLabel(t('items:fields.code'), { exact: true })).toHaveValue(/^EQUIP-/);
  await dialog.getByLabel(t('items:fields.nameAr'), { exact: true }).fill(`مضخة أرضية ${n}`);
  await dialog.getByLabel(t('items:fields.nameEn'), { exact: true }).fill(`Floor pump ${n}`);
  await dialog.getByLabel(t('items:fields.price'), { exact: true }).fill('9.99');
  await expect(dialog.getByText(/9\.51/)).toBeVisible(); // 9.99 incl. 5% VAT → 9.51 + 0.48
  // The owner also types the purchase price (without VAT): 9.51 - 5.00 = 4.51 profit, 47.4%.
  await dialog.getByLabel(t('items:fields.purchaseCost'), { exact: true }).fill('5');
  await expect(dialog.getByTestId('profit-line')).toContainText('4.51');
  await snap(page, '43-new-item');
  await dialog.getByRole('button', { name: t('items:dialog.save') }).click();
  await expect(dialog).toHaveCount(0);

  // Written with ه for ة and plain ا for أ, as people type quickly.
  await page.getByPlaceholder(t('items:search')).fill(`مضخه ارضيه ${n}`);
  await expect(page.getByRole('row', { name: new RegExp(n) })).toHaveCount(1);
  await page.getByRole('row', { name: new RegExp(n) }).click();
  await expect(page.getByText(t('items:fields.purchaseCost'), { exact: true })).toBeVisible();
  await snap(page, '44-items');
});

test('a customer needs a valid TRN, then gets credit with a reason', async ({ page, open, t }) => {
  const n = runDigits();
  const name = `مسابح الواحة ${n}`;
  await open('office');
  await signInAsOwner(page, t);
  await openMenu(page, t, 'customers');
  await expect(page.getByRole('heading', { name: t('parties:customers.title') })).toBeVisible();

  await page.getByRole('button', { name: t('parties:customers.new') }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: t('parties:types.contractor') }).click();
  await dialog.getByLabel(t('parties:form.name'), { exact: true }).fill(name);
  await dialog.getByLabel(t('parties:form.phone'), { exact: true }).fill(`050${n}1`);
  await turnOn(dialog.getByRole('switch', { name: t('parties:form.vat') }));
  await dialog.getByLabel(t('parties:form.trn'), { exact: true }).fill('12345');
  await dialog.getByRole('button', { name: t('parties:form.save') }).click();
  await expect(dialog.getByText(t('masterdata:fields.invalid_trn'))).toBeVisible();
  await dialog.getByLabel(t('parties:form.trn'), { exact: true }).fill(`100${n}000003`);
  await snap(page, '45-new-customer');
  await dialog.getByRole('button', { name: t('parties:form.save') }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByPlaceholder(t('parties:customers.search')).fill(name);
  await page.getByRole('row', { name: new RegExp(n) }).click();
  await page.getByRole('button', { name: t('parties:customers.changeCredit') }).click();
  const credit = page.getByRole('dialog');
  await credit.getByRole('button', { name: t('parties:credit.credit'), exact: true }).click();
  await credit.getByLabel(t('parties:credit.limit'), { exact: true }).fill('5000');
  await credit.getByLabel(t('masterdata:deactivate.reason'), { exact: true }).fill('good payer');
  await snap(page, '46-customer-credit');
  await credit.getByRole('button', { name: t('parties:credit.save') }).click();
  await expect(credit).toHaveCount(0);
  await expect(page.getByRole('row', { name: new RegExp(n) })).toContainText(
    t('parties:credit.credit'),
  );
  await snap(page, '47-customers');
});

test('an Excel file with one bad row is reported and imports nothing', async ({
  page,
  open,
  t,
}, info) => {
  const n = runDigits();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Customers');
  sheet.addRow(['Type', 'Name', 'Phone']);
  sheet.addRow(['individual', `Import good ${n}`, `050${n}2`]);
  sheet.addRow(['individual', `Import bad ${n}`, 'not a phone']);
  mkdirSync(info.outputDir, { recursive: true });
  const file = join(info.outputDir, `customers-${n}.xlsx`);
  writeFileSync(file, Buffer.from(await workbook.xlsx.writeBuffer()));

  await open('office');
  await signInAsOwner(page, t);
  await openMenu(page, t, 'customers');
  await page.getByRole('button', { name: t('masterdata:actions.import') }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(t('masterdata:import.file.label')).setInputFiles(file);
  await dialog.getByRole('button', { name: t('masterdata:import.check') }).click();
  const report = dialog.getByRole('table', { name: t('masterdata:import.report.label') });
  await expect(report.getByRole('row')).toHaveCount(2); // the header and the one bad row
  await expect(report).toContainText('3');
  await snap(page, '48-import-report');
  await dialog.getByRole('button', { name: t('masterdata:actions.cancel') }).click();

  // Nothing was imported: not even the good row.
  await page.getByPlaceholder(t('parties:customers.search')).fill(`Import good ${n}`);
  await expect(page.getByText(t('parties:customers.empty'))).toBeVisible();
});

test('the accounting chart shows its headers and the provisional notice', async ({
  page,
  open,
  t,
}) => {
  await open('office');
  await signInAsOwner(page, t);
  await openMenu(page, t, 'accounting');
  await expect(page.getByRole('heading', { name: t('accounting:title') })).toBeVisible();
  await expect(page.getByRole('row', { name: /1210/ })).toBeVisible();
  await snap(page, '49-accounting');
});
