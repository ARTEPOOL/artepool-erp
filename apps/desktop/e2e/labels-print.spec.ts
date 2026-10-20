/**
 * Barcode labels (decisions 0043, 0096) in a real browser with the real fonts, in Arabic and
 * English: the label drawn for a long name keeps every part apart and inside the printable width,
 * the price reads "120.00 درهم" / "AED 120.00", the drawn barcode is read back by a barcode reader,
 * and the labels sent to the print dialog are visible (no other print rule of the app hides them).
 */
import { readBarcodes } from 'zxing-wasm/reader';
import type { Locator, Page } from '@playwright/test';
import { expect, signInAsOwner, test } from './fixtures';

const LONG_AR = 'كلور حبوب سريع الذوبان للمسابح الكبيرة والصغيرة عبوة خمسة كيلو من إنتاج الشركة';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Layout {
  widthDots: number;
  content: Box;
  boxes: { part: string; box: Box }[];
  texts: { part: string; text: string }[];
  prices: { text: string; x: number; dir: string }[][];
  moduleDots: number;
}

const textsOf = (layout: Layout, part: string) =>
  layout.texts.filter((l) => l.part === part).map((l) => l.text);

/** A new item with a long Arabic name and a price including VAT; its labels dialog opened. */
async function openLabels(page: Page, t: (key: string) => string, lang: string) {
  const n = `${Date.now() % 1_000_000}`.padStart(6, '0');
  await page.getByRole('link', { name: t('settings:nav.items') }).click();
  await page.getByRole('button', { name: t('items:newItem') }).click();
  const form = page.getByRole('dialog');
  await form
    .getByLabel(t('items:fields.category'), { exact: true })
    .selectOption({ label: lang === 'en' ? 'Equipment' : 'معدات' });
  await form.getByLabel(t('items:fields.nameAr'), { exact: true }).fill(`${LONG_AR} ${n}`);
  await form.getByLabel(t('items:fields.nameEn'), { exact: true }).fill(`Chlorine ${n}`);
  await form.getByLabel(t('items:fields.price'), { exact: true }).fill('120');
  await form.getByRole('button', { name: t('items:dialog.save') }).click();
  await expect(form).toHaveCount(0);
  await page
    .getByRole('button', { name: t('items:labels.button') })
    .first()
    .click();
  return page.getByRole('dialog');
}

/**
 * Every pixel of an image shown on the page, read back: true when each one is pure black (0) or
 * pure white (255), as the 1-bit image the printer gets must be (decision 0097).
 */
async function onlyBlackAndWhite(image: Locator): Promise<{ pixels: number; grey: number }> {
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
    return { pixels: data.length / 4, grey };
  });
}

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('a long name, the price and the barcode: apart, inside, readable', async ({
  page,
  open,
  t,
  lang,
}) => {
  await open('office');
  await signInAsOwner(page, t);
  const dialog = await openLabels(page, t, lang);
  const preview = dialog.getByTestId('label-preview');
  await expect(preview).toBeVisible();
  const layout = JSON.parse((await preview.getAttribute('data-layout'))!) as Layout;

  // The 50 × 30 default: everything inside the printable width (48 mm at 203 dpi), nothing overlaps.
  expect(layout.widthDots).toBe(400);
  expect(layout.content.w).toBeLessThanOrEqual(384);
  for (const { part, box } of layout.boxes) {
    expect(box.x, part).toBeGreaterThanOrEqual(layout.content.x);
    expect(box.x + box.w, part).toBeLessThanOrEqual(layout.content.x + layout.content.w);
  }
  layout.boxes.forEach((a, i) =>
    layout.boxes
      .slice(i + 1)
      .forEach((b) => expect(overlap(a.box, b.box), `${a.part}/${b.part}`).toBe(false)),
  );
  // The Arabic name in 2 lines at most, cut with "…" when longer.
  expect(textsOf(layout, 'nameAr').length).toBeLessThanOrEqual(2);
  expect(textsOf(layout, 'nameAr').join(' ').length).toBeGreaterThan(10);

  // The price in the design's language (Arabic by default), the number its own run, to the right
  // of the currency: read from the right, "120.00 درهم".
  const [first, second] = layout.prices[0]!;
  expect([first!.text, second!.text]).toEqual(['درهم', '120.00']);
  expect(second!.x).toBeGreaterThan(first!.x);

  // Pure 1-bit: every pixel black or white, at the printer's 400 × 240 dots (50 × 30 mm, 203 dpi).
  expect(await onlyBlackAndWhite(preview.getByRole('img'))).toEqual({ pixels: 400 * 240, grey: 0 });

  // The drawn label is read back by a barcode reader (the item code, Code 128).
  const src = await preview.getByRole('img').getAttribute('src');
  const png = Buffer.from(src!.replace(/^data:image\/png;base64,/, ''), 'base64');
  const [found] = await readBarcodes(new Uint8Array(png), { formats: ['Code128'] });
  expect(found?.text).toMatch(/^[A-Z]+-\d{4}$/);

  // The English name when asked for.
  await dialog.getByText(t('items:labels.addEnglish'), { exact: true }).click();
  const withEnglish = JSON.parse((await preview.getAttribute('data-layout'))!) as Layout;
  expect(textsOf(withEnglish, 'nameEn')[0]).toMatch(/^Chlorine \d{6}$/);
});

test('the printed labels are visible on the page', async ({ page, open, t, lang }) => {
  await open('office');
  await signInAsOwner(page, t);
  const dialog = await openLabels(page, t, lang);
  await dialog.getByLabel(t('items:labels.count'), { exact: true }).fill('2');
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => {
    window.print = () => {
      const labels = [...document.querySelectorAll('[data-testid="label-print"] > img')];
      (window as unknown as { printed: unknown }).printed = labels.map((label) => ({
        visible: getComputedStyle(label).visibility === 'visible',
        height: label.getBoundingClientRect().height,
        drawn: (label as HTMLImageElement).naturalWidth,
      }));
    };
  });
  // In print mode the screen itself is hidden: submit the form as the Print button does.
  await page
    .locator('[data-testid="label-preview"]')
    .evaluate((preview) => preview.closest('form')!.requestSubmit());
  const printed = await page.waitForFunction(
    () => (window as unknown as { printed?: unknown }).printed,
  );
  const labels = (await printed.jsonValue()) as {
    visible: boolean;
    height: number;
    drawn: number;
  }[];
  expect(labels).toHaveLength(2);
  for (const label of labels) {
    expect(label.visible).toBe(true);
    // 30 mm high on paper; drawn at the label printer's 400 dots across (50 mm at 203 dpi).
    expect(label.height).toBeGreaterThan(100);
    expect(label.drawn).toBe(400);
  }
});

test('label printer: the test and quality labels are pure black and white', async ({
  page,
  open,
  t,
}) => {
  await open('office');
  await signInAsOwner(page, t);
  await page.getByRole('link', { name: t('settings:nav.settings') }).click();
  await page.getByRole('link', { name: t('settings:hub.devices') }).click();
  await expect(
    page.getByRole('heading', { name: t('settings:devices.labelPrinter') }),
  ).toBeVisible();
  for (const id of ['label-test-preview', 'label-quality-preview']) {
    const image = page.getByTestId(id);
    await expect(image).toBeVisible();
    expect(await onlyBlackAndWhite(image)).toEqual({ pixels: 400 * 240, grey: 0 });
  }
});
