/**
 * The barcode label designer (decision 0097) in a real browser with the real fonts, in Arabic and
 * English: the previews show every active size as 1-bit images; the owner shows the English name
 * everywhere but hides it on 40 × 30 (a per-size override) and saves; the labels dialog then follows
 * the saved design for each size. At the end "Reset to default design" is saved again, so the other
 * tests find the default design.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, signInAsOwner, snap, test } from './fixtures';

test.setTimeout(180_000);

async function openDesigner(page: Page, t: (key: string) => string) {
  await page.getByRole('link', { name: t('settings:nav.settings') }).click();
  await page.getByRole('link', { name: t('settings:hub.print') }).click();
  await page.getByRole('tab', { name: t('settings:print.kinds.barcode_label') }).click();
  await expect(page.getByTestId('label-design-preview-50X30').getByRole('img')).toBeVisible();
}

/** Every pixel of a shown image is pure black or pure white (the printer gets 1-bit dots). */
async function greyPixels(image: Locator): Promise<number> {
  return image.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let grey = 0;
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) if (data[i + c] !== 0 && data[i + c] !== 255) grey += 1;
    }
    return grey;
  });
}

async function saveDesign(page: Page, t: (key: string) => string) {
  await page.getByRole('button', { name: t('settings:print.save'), exact: true }).click();
  await expect(page.getByText(t('settings:print.unsaved'))).toHaveCount(0);
}

/** A 12-digit start and its EAN-13 check digit. */
function ean13(start: string): string {
  const sum = [...start].reduce((total, d, i) => total + Number(d) * (i % 2 ? 3 : 1), 0);
  return `${start}${(10 - (sum % 10)) % 10}`;
}

const textsOf = async (preview: Locator, part: string) =>
  (
    JSON.parse((await preview.getAttribute('data-layout'))!) as {
      texts: { part: string; text: string }[];
    }
  ).texts
    .filter((line) => line.part === part)
    .map((line) => line.text);

test('the owner designs the label; printing follows it for each size', async ({
  page,
  open,
  t,
  lang,
}) => {
  await open('office');
  await signInAsOwner(page, t);
  await openDesigner(page, t);
  // Another test may have left a design: start from the default one.
  await page.getByRole('button', { name: t('settings:labelDesign.reset') }).click();
  if (await page.getByText(t('settings:print.unsaved')).count()) await saveDesign(page, t);

  // Every active size has a preview, drawn in pure black and white at the printer's dots.
  for (const code of ['50X30', '50X25', '40X30']) {
    const preview = page.getByTestId(`label-design-preview-${code}`);
    await expect(preview.getByRole('img')).toBeVisible();
    expect(await greyPixels(preview.getByRole('img')), code).toBe(0);
  }

  // The English name on every size but 40 × 30.
  await page
    .getByTestId('label-element-nameEn')
    .getByText(t('settings:labelDesign.elements.nameEn'), { exact: true })
    .click();
  await page
    .getByLabel(t('settings:labelDesign.overrideSize'), { exact: true })
    .selectOption('40X30');
  await page
    .getByLabel(
      t('settings:labelDesign.overrideShow', {
        element: t('settings:labelDesign.elements.nameEn'),
      }),
      { exact: true },
    )
    .selectOption('hide');
  await snap(page, '90-label-designer');
  await saveDesign(page, t);

  // A new item: the labels dialog follows the saved design.
  const n = `${Date.now() % 1_000_000}`.padStart(6, '0');
  await page.getByRole('link', { name: t('settings:nav.items') }).click();
  await page.getByRole('button', { name: t('items:newItem') }).click();
  const form = page.getByRole('dialog');
  await form
    .getByLabel(t('items:fields.category'), { exact: true })
    .selectOption({ label: lang === 'en' ? 'Equipment' : 'معدات' });
  await form.getByLabel(t('items:fields.nameAr'), { exact: true }).fill(`مضخة ${n}`);
  await form.getByLabel(t('items:fields.nameEn'), { exact: true }).fill(`Pump ${n}`);
  await form.getByLabel(t('items:fields.price'), { exact: true }).fill('95');
  // A supplier's EAN-13, as most bought-in items have: it fits every size.
  await form.getByRole('button', { name: t('items:barcodes.add') }).click();
  await form
    .getByLabel(t('items:barcodes.barcodeN', { n: 1 }), { exact: true })
    .fill(ean13(`629${n}000`));
  await form.getByRole('button', { name: t('items:dialog.save') }).click();
  await expect(form).toHaveCount(0);
  await page
    .getByRole('button', { name: t('items:labels.button') })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  const preview = dialog.getByTestId('label-preview');
  const sizeField = dialog.getByLabel(t('items:labels.size'), { exact: true });

  const chooseSize = async (size: string) =>
    sizeField.selectOption(
      await sizeField.locator('option', { hasText: `(${size})` }).getAttribute('value'),
    );
  await chooseSize('50 × 30');
  await expect(preview).toBeVisible();
  expect(await textsOf(preview, 'nameEn')).toEqual([`Pump ${n}`]);
  await chooseSize('40 × 30');
  await expect.poll(() => textsOf(preview, 'nameEn')).toEqual([]);
  expect((await textsOf(preview, 'nameAr')).join(' ')).toContain(n);
  await dialog.getByRole('button', { name: t('items:adjust.cancel') }).click();

  // Back to the default design, saved, for the other tests.
  await openDesigner(page, t);
  await page.getByRole('button', { name: t('settings:labelDesign.reset') }).click();
  await saveDesign(page, t);
});
