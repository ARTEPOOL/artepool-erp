/**
 * Inventory (M3) against the real server: the owner posts opening stock (10 × 1.2345), removes 3
 * then 7, and the stock and its value end at exactly 0.00; the journal shows the opening entry
 * (Inventory / Opening balance equity); the counts and oversell review pages open from Items.
 */
import { expect, signInAsOwner, snap, test } from './fixtures';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

/** Different for each project and run, in digits only. */
const runDigits = () => `${Date.now() % 1_000_000}`.padStart(6, '0');

async function newStockItem(page: Page, t: (key: string) => string, lang: string, n: string) {
  await page.getByRole('link', { name: t('settings:nav.items') }).click();
  await page.getByRole('button', { name: t('items:newItem') }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel(t('items:fields.category'), { exact: true })
    .selectOption({ label: lang === 'en' ? 'Equipment' : 'معدات' });
  await dialog.getByLabel(t('items:fields.nameAr'), { exact: true }).fill(`فلتر رملي ${n}`);
  await dialog.getByLabel(t('items:fields.nameEn'), { exact: true }).fill(`Sand filter ${n}`);
  await dialog.getByLabel(t('items:fields.price'), { exact: true }).fill('20');
  const code = await dialog.getByLabel(t('items:fields.code'), { exact: true }).inputValue();
  await dialog.getByRole('button', { name: t('items:dialog.save') }).click();
  await expect(dialog).toHaveCount(0);
  return code;
}

async function removeQuantity(page: Page, t: (key: string) => string, quantity: string) {
  await page.getByRole('button', { name: t('items:stock.adjust'), exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: t('items:adjust.ops.decrease'), exact: true }).click();
  await dialog.getByLabel(t('items:adjust.quantityOut'), { exact: true }).fill(quantity);
  await dialog.locator('#adjust-reason').selectOption({ index: 1 });
  await dialog.getByLabel(new RegExp(t('items:adjust.note'))).fill('e2e removal');
  await dialog.getByRole('button', { name: t('items:adjust.save') }).click();
  await expect(dialog).toHaveCount(0);
}

test('opening stock 10 × 1.2345, remove 3 then 7: the books end at exactly 0.00', async ({
  page,
  open,
  t,
  lang,
}) => {
  const n = runDigits();
  await open('office');
  await signInAsOwner(page, t);
  const code = await newStockItem(page, t, lang, n);

  // Opening stock, from the button on Items & stock.
  await page.getByRole('button', { name: t('items:stock.openingTool') }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: t('inventory:opening.title') }),
  ).toBeVisible();
  await page.getByLabel(t('inventory:picker.search')).fill(code);
  await page
    .getByRole('list', { name: t('inventory:picker.results') })
    .getByRole('button', { name: new RegExp(code) })
    .click();
  const lines = page.getByRole('table', { name: t('inventory:opening.form.lines') });
  await lines.getByRole('textbox').nth(0).fill('10');
  await lines.getByRole('textbox').nth(1).fill('1.2345');
  await expect(page.getByText('12.35').first()).toBeVisible(); // 12.345 → 12.35 (half away from zero)
  await snap(page, '60-opening-stock');
  await page.getByRole('button', { name: t('inventory:opening.form.post') }).click();
  const done = page.getByRole('status').filter({ hasText: t('inventory:opening.done') });
  await expect(done).toContainText('JV-');
  const entry = (await done.locator('bdi').nth(1).innerText()).trim();
  await snap(page, '61-opening-posted');

  // Remove 3, then the last 7: the last unit takes exactly what is left.
  await page.getByRole('link', { name: t('settings:nav.items') }).click();
  await page.getByPlaceholder(t('items:search')).fill(code);
  await page.getByRole('row', { name: new RegExp(code) }).click();
  const stock = page.getByRole('region', { name: t('items:stock.title') });
  await expect(stock.getByTestId('stock-pair')).toContainText('10');
  await expect(stock).toContainText('12.35');
  await removeQuantity(page, t, '3');
  await expect(stock.getByTestId('stock-pair')).toContainText('7');
  await expect(stock).toContainText('8.64'); // 7 × 1.2345 = 8.6415
  await snap(page, '62-stock-card');
  await removeQuantity(page, t, '7');
  await expect(stock).toContainText('0.00');
  await expect(stock).not.toContainText('8.64');

  // The opening entry in the journal: Inventory 1310 debit, Opening balance equity 3900 credit.
  await page.getByRole('link', { name: t('settings:nav.accounting') }).click();
  await page.getByRole('tab', { name: t('accounting:tabs.journal') }).click();
  await page.getByRole('row', { name: t('accounting:journal.openOne', { number: entry }) }).click();
  const detail = page.getByRole('dialog');
  const entryLines = detail.getByRole('table', { name: t('accounting:entry.lines') });
  await expect(entryLines.getByRole('row', { name: /1310/ })).toContainText('12.35');
  await expect(entryLines.getByRole('row', { name: /3900/ })).toContainText('12.35');
  await snap(page, '63-journal-entry');
});

test('the counts and oversell review pages open from Items & stock', async ({ page, open, t }) => {
  await open('office');
  await signInAsOwner(page, t);
  await page.getByRole('link', { name: t('settings:nav.items') }).click();
  await page.getByRole('button', { name: t('items:stock.countTool') }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: t('inventory:counts.title') }),
  ).toBeVisible();
  // The side menu keeps Items & stock as the current page.
  await expect(page.getByRole('link', { name: t('settings:nav.items') })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await snap(page, '64-counts');
  await page.getByRole('link', { name: t('settings:nav.items') }).click();
  await page.getByRole('button', { name: t('items:stock.reviewsTool') }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: t('inventory:reviews.title') }),
  ).toBeVisible();
  await snap(page, '65-oversell-reviews');
});
