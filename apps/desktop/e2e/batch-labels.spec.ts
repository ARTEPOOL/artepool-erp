/**
 * Labels for many items (decision 0099) against the real server, in Arabic and English: a scanned
 * item is printed and recorded (after "did the labels print?"); its price changes in the item
 * window; it then shows on the "price changed" list with the old and new price and one label per
 * unit on hand; more than 100 labels ask first; printed with the new price, it leaves the list.
 */
import type { Page } from '@playwright/test';
import { control, expect, signInAsOwner, snap, test } from './fixtures';

test.setTimeout(180_000);

/** A 12-digit start and its EAN-13 check digit. */
function ean13(start: string): string {
  const sum = [...start].reduce((total, d, i) => total + Number(d) * (i % 2 ? 3 : 1), 0);
  return `${start}${(10 - (sum % 10)) % 10}`;
}

/** The print dialog is replaced: it "prints" and reports done, as a real one does. */
async function stubPrintDialog(page: Page) {
  await page.evaluate(() => {
    window.print = () => {
      setTimeout(() => window.dispatchEvent(new Event('afterprint')), 50);
    };
  });
}

test('print many, change a price, the "price changed" list, print again', async ({
  page,
  open,
  t,
}) => {
  const n = `${Date.now() % 1_000_000}`.padStart(6, '0');
  const code = `LB-${n}`;
  const barcode = ean13(`629${n}777`);
  await control.addPosItem({
    code,
    nameAr: `ملصق ${n}`,
    nameEn: `Label ${n}`,
    barcode,
    price4dp: '1000000',
    quantityMilli: '3000',
  });
  await open('office');
  await signInAsOwner(page, t);
  await page.getByRole('link', { name: t('settings:nav.items') }).click();
  await stubPrintDialog(page);

  // 1) Chosen by scanning: two labels, printed through the print dialog, recorded on "yes".
  await page.getByRole('button', { name: t('items:labels.batchButton') }).click();
  let dialog = page.getByRole('dialog', { name: t('items:labels.batch.title') });
  const search = dialog.getByLabel(t('items:labels.batch.search'));
  await search.fill(barcode);
  await search.press('Enter');
  const row = dialog.getByTestId(`labels-line-${code}`);
  const count = row.getByRole('textbox');
  await expect(count).toHaveValue('1');
  await count.fill('2');
  await expect(dialog.getByTestId('labels-total')).toHaveText(
    t('items:labels.batch.total', { count: 2 }),
  );
  await dialog.getByRole('button', { name: t('items:labels.batch.print', { count: 2 }) }).click();
  await dialog.getByRole('button', { name: t('items:labels.didPrintYes') }).click();
  await expect(dialog.getByRole('button', { name: t('items:labels.didPrintYes') })).toHaveCount(0);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: t('items:adjust.cancel') }).click();

  // 2) The price changes in the item window: 100.00 → 120.00.
  const itemsSearch = page.getByRole('searchbox', { name: t('items:search') });
  await itemsSearch.fill(code);
  await itemsSearch.press('Enter');
  await page.getByRole('button', { name: t('masterdata:actions.edit'), exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel(t('items:fields.price'), { exact: true }).fill('120');
  await form.getByRole('button', { name: t('items:dialog.save') }).click();
  await expect(form).toHaveCount(0);

  // 3) On the "price changed" list: old and new price, one label per unit on hand (3).
  await page.getByRole('button', { name: t('items:labels.batchButton') }).click();
  dialog = page.getByRole('dialog', { name: t('items:labels.batch.title') });
  await dialog.getByRole('button', { name: t('items:labels.batch.sources.price_changed') }).click();
  const listed = dialog.getByTestId(`labels-line-${code}`);
  await expect(listed.getByRole('textbox')).toHaveValue('3');
  await expect(listed).toContainText(`100.00 ${t('items:labels.batch.arrow')} 120.00`);
  // Only this item (other tests' items may be on the list too).
  const others = dialog.locator(
    `tr[data-testid^="labels-line-"]:not([data-testid="labels-line-${code}"])`,
  );
  while ((await others.count()) > 0) {
    await others.first().getByRole('button').click();
  }
  await snap(page, '91-labels-price-changed');

  // More than 100 labels: asked first.
  await listed.getByRole('textbox').fill('101');
  await dialog.getByRole('button', { name: t('items:labels.batch.print', { count: 101 }) }).click();
  await expect(dialog.getByText(t('items:labels.batch.confirm', { count: 101 }))).toBeVisible();
  await dialog.getByRole('button', { name: t('items:labels.batch.confirmNo') }).click();
  await listed.getByRole('textbox').fill('3');

  // 4) Printed with the new price: recorded, and the item leaves the list.
  await dialog.getByRole('button', { name: t('items:labels.batch.print', { count: 3 }) }).click();
  await dialog.getByRole('button', { name: t('items:labels.didPrintYes') }).click();
  await expect(dialog.getByTestId(`labels-line-${code}`)).toHaveCount(0);
});
