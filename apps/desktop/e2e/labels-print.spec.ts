/**
 * Printing barcode labels (decision 0043) puts real, visible labels on the page: no other print
 * rule of the app (for example the backup key's) may hide them. The print dialog is replaced by a
 * check of what the printer would get, in print mode.
 */
import { expect, signInAsOwner, test } from './fixtures';

test('the printed labels are visible on the page', async ({ page, open, t, lang }) => {
  const n = `${Date.now() % 1_000_000}`.padStart(6, '0');
  await open('office');
  await signInAsOwner(page, t);
  await page.getByRole('link', { name: t('settings:nav.items') }).click();
  await page.getByRole('button', { name: t('items:newItem') }).click();
  let dialog = page.getByRole('dialog');
  await dialog
    .getByLabel(t('items:fields.category'), { exact: true })
    .selectOption({ label: lang === 'en' ? 'Equipment' : 'معدات' });
  await dialog.getByLabel(t('items:fields.nameAr'), { exact: true }).fill(`مضخة ${n}`);
  await dialog.getByLabel(t('items:fields.nameEn'), { exact: true }).fill(`Pump ${n}`);
  await dialog.getByLabel(t('items:fields.price'), { exact: true }).fill('20');
  await dialog.getByRole('button', { name: t('items:dialog.save') }).click();
  await expect(dialog).toHaveCount(0);

  await page
    .getByRole('button', { name: t('items:labels.button') })
    .first()
    .click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel(t('items:labels.count'), { exact: true }).fill('2');
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => {
    window.print = () => {
      const labels = [...document.querySelectorAll('[data-testid="label-print"] > *')];
      (window as unknown as { printed: unknown }).printed = labels.map((label) => {
        const bars = label.querySelector('svg')!;
        return {
          visible: getComputedStyle(bars).visibility === 'visible',
          height: bars.getBoundingClientRect().height,
        };
      });
    };
  });
  // In print mode the screen itself is hidden: submit the form as the Print button does.
  await page
    .locator('[data-testid="label-preview"]')
    .evaluate((preview) => preview.closest('form')!.requestSubmit());
  const printed = await page.waitForFunction(
    () => (window as unknown as { printed?: unknown }).printed,
  );
  const labels = (await printed.jsonValue()) as { visible: boolean; height: number }[];
  expect(labels).toHaveLength(2);
  for (const label of labels) {
    expect(label.visible).toBe(true);
    expect(label.height).toBeGreaterThan(10);
  }
});
