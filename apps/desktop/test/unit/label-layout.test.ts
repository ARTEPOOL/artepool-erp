// @vitest-environment node
/**
 * The barcode label layout (decision 0096): for every size, short or very long Arabic and English
 * names, with or without the price and "incl. VAT", nothing overlaps, everything stays inside the
 * printable width, the name keeps to 2 lines and the price reads in the right order. Text is measured
 * here with a simple estimate; the real fonts are checked in the browser (Playwright).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { barcodeFor } from '../../src/features/items/labels/barcode';
import {
  LABEL_MM,
  layoutBoxes,
  layoutLabel,
  wrapLines,
  type LabelLayout,
  type LabelText,
  type Measurer,
} from '../../src/features/items/labels/layout';

/**
 * A little larger than the app's real fonts measured in Chromium (GE SS TV: Arabic letters about
 * 0.39 em wide, up to 0.82 em above and 0.43 em below the baseline), so the checks have a safety margin.
 */
const measurer: Measurer = {
  width: (text, font, bold) =>
    [...text].reduce((sum, c) => {
      const em = c === ' ' ? 0.28 : c === '…' ? 0.9 : /[\u0600-\u06FF]/.test(c) ? 0.5 : 0.56;
      return sum + em * font * (bold ? 1.06 : 1);
    }, 0),
  extent: (font, script) =>
    script === 'arabic'
      ? { ascent: font * 0.88, descent: font * 0.48 }
      : { ascent: font * 0.9, descent: font * 0.24 },
};

const PRESETS = [
  [50, 30],
  [50, 25],
  [40, 30],
  [38, 25],
] as const;

const LONG_AR = 'كلور حبوب ٩٠٪ سريع الذوبان للمسابح الكبيرة والصغيرة عبوة ٥ كجم من إنتاج الشركة';
const LONG_EN = 'Chlorine tablets 90% fast dissolving for large and small pools, 5 kg bucket';

const text = (over: Partial<LabelText> = {}): LabelText => ({
  nameAr: 'كلور أقراص',
  barcode: barcodeFor('6291041500213')!,
  price: { language: 'ar', amount: '120.00', currency: 'درهم', vatNote: 'شامل الضريبة' },
  ...over,
});

const geometry = (widthMm: number, heightMm: number, dpi = 203, printableWidthMm = 48) => ({
  widthMm,
  heightMm,
  dpi,
  printableWidthMm,
});

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The rules every printed label keeps. */
function expectSound(layout: LabelLayout, printableWidthMm: number, dpi: number) {
  const boxes = layoutBoxes(layout);
  const { content } = layout;
  // Inside the printable width (centred on the label), and inside the label's height.
  expect(content.w).toBeLessThanOrEqual(Math.round((printableWidthMm * dpi) / 25.4));
  expect(Math.abs(content.x * 2 + content.w - layout.widthDots)).toBeLessThanOrEqual(1);
  for (const { part, box } of boxes) {
    expect(box.x, part).toBeGreaterThanOrEqual(content.x);
    expect(box.x + box.w, part).toBeLessThanOrEqual(content.x + content.w);
    expect(box.y, part).toBeGreaterThanOrEqual(content.y);
    expect(box.y + box.h, part).toBeLessThanOrEqual(content.y + content.h);
  }
  // Nothing overlaps anything else.
  boxes.forEach((a, i) =>
    boxes
      .slice(i + 1)
      .forEach((b) => expect(overlap(a.box, b.box), `${a.part}/${b.part}`).toBe(false)),
  );
  expect(layout.name.length).toBeLessThanOrEqual(2);
  expect(layout.bars.h).toBeGreaterThanOrEqual(Math.round((LABEL_MM.bars.min * dpi) / 25.4));
  for (const bar of layout.bars.rects) expect(bar.w % layout.bars.moduleDots).toBe(0);
}

describe('wrapping the name', () => {
  it('keeps to the lines allowed and ends a cut name with "…"', () => {
    const wrapped = wrapLines(measurer, LONG_AR, 300, 24, true, 2);
    expect(wrapped.cut).toBe(true);
    expect(wrapped.lines).toHaveLength(2);
    expect(wrapped.lines[1]!.endsWith('…')).toBe(true);
    for (const line of wrapped.lines)
      expect(measurer.width(line, 24, true)).toBeLessThanOrEqual(300);
    expect(wrapLines(measurer, 'كلور', 300, 24, true, 2)).toEqual({ lines: ['كلور'], cut: false });
  });

  it('cuts one very long word too', () => {
    const wrapped = wrapLines(measurer, `${'ك'.repeat(80)} آخر`, 200, 24, true, 2);
    expect(wrapped.lines).toHaveLength(1);
    expect(measurer.width(wrapped.lines[0]!, 24, true)).toBeLessThanOrEqual(200);
  });
});

describe('the label sizes', () => {
  it.each(PRESETS)('%i × %i mm fits a long Arabic name, the price and incl. VAT', (w, h) => {
    for (const dpi of [203, 300]) {
      const layout = layoutLabel(
        geometry(w, h, dpi),
        text({ nameAr: LONG_AR, nameEn: LONG_EN }),
        measurer,
      );
      expect(layout.ok).toBe(true);
      if (layout.ok) expectSound(layout, 48, dpi);
    }
  });

  it('50 × 30: a short name in one line at the largest size, EAN-13 bars of 3 dots, centred', () => {
    const layout = layoutLabel(geometry(50, 30), text(), measurer);
    if (!layout.ok) throw new Error('refused');
    expect(layout.name).toHaveLength(1);
    expect(layout.name[0]!.fontDots).toBe(Math.round((LABEL_MM.name.max * 203) / 25.4));
    expect(layout.bars.moduleDots).toBe(3);
    // 50 mm label, 48 mm printable: the content starts 1 mm in from the printable edge.
    expect(layout.content.x).toBe(Math.floor((400 - (384 - 16)) / 2));
  });

  it('a long name takes 2 smaller lines; the last ends in "…" when still too long', () => {
    const layout = layoutLabel(geometry(50, 25), text({ nameAr: LONG_AR }), measurer);
    if (!layout.ok) throw new Error('refused');
    expect(layout.name).toHaveLength(2);
    expect(layout.name[1]!.text.endsWith('…')).toBe(true);
    expect(layout.name[0]!.fontDots).toBeGreaterThanOrEqual(
      Math.round((LABEL_MM.name.min * 203) / 25.4),
    );
  });

  it('adds the English name only when asked and there is room', () => {
    const roomy = layoutLabel(geometry(50, 30), text({ nameEn: 'Chlorine tablets' }), measurer);
    expect(roomy.ok && roomy.english?.text).toBe('Chlorine tablets');
    const none = layoutLabel(geometry(50, 30), text(), measurer);
    expect(none.ok && none.english).toBe(null);
  });

  it('refuses a label too small for the name, bars and price, and a barcode too long for it', () => {
    expect(layoutLabel(geometry(50, 15), text(), measurer)).toEqual({
      ok: false,
      reason: 'too_small',
    });
    expect(
      layoutLabel(geometry(25, 30), text({ barcode: barcodeFor('PUMP-HAYWARD-1.5HP')! }), measurer),
    ).toEqual({
      ok: false,
      reason: 'barcode_too_long',
    });
  });
});

describe('the price', () => {
  it('reads "120.00 درهم" from the right on Arabic labels: the number right of "درهم"', () => {
    const layout = layoutLabel(geometry(50, 30), text(), measurer);
    if (!layout.ok || !layout.price) throw new Error('refused');
    const [currency, amount] = layout.price.runs;
    expect(currency).toMatchObject({ text: 'درهم', dir: 'rtl' });
    expect(amount).toMatchObject({ text: '120.00', dir: 'ltr' });
    expect(amount!.x).toBeGreaterThan(currency!.x);
  });

  it('reads "AED 120.00" on English labels', () => {
    const layout = layoutLabel(
      geometry(50, 30),
      text({ price: { language: 'en', amount: '120.00', currency: 'AED', vatNote: 'incl. VAT' } }),
      measurer,
    );
    if (!layout.ok || !layout.price) throw new Error('refused');
    const [currency, amount] = layout.price.runs;
    expect(currency).toMatchObject({ text: 'AED', dir: 'ltr' });
    expect(amount!.x).toBeGreaterThan(currency!.x);
    expect(layout.vat?.text).toBe('incl. VAT');
  });

  it('no "incl. VAT" line when the price does not include VAT, no price line when not wanted', () => {
    const plain = layoutLabel(
      geometry(50, 30),
      text({ price: { language: 'ar', amount: '120.00', currency: 'درهم', vatNote: null } }),
      measurer,
    );
    expect(plain.ok && plain.vat).toBe(null);
    const bare = layoutLabel(geometry(50, 30), text({ price: null }), measurer);
    expect(bare.ok && bare.price).toBe(null);
  });
});

describe('property: never overlapping, always inside the printable width', () => {
  const arabicWord = fc.stringMatching(/^[\u0621-\u064A]{1,12}$/);
  const latinWord = fc.stringMatching(/^[A-Za-z0-9%.,-]{1,14}$/);
  const words = (word: fc.Arbitrary<string>) =>
    fc.array(word, { minLength: 1, maxLength: 18 }).map((w) => w.join(' '));
  const barcodeData = fc.oneof(
    fc.constant('6291041500213'),
    fc.constant('036000291452'),
    fc.stringMatching(/^[A-Z]{2,5}-\d{4}$/),
  );

  it('for any size up to the roll, any names, with or without the price', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 30, max: 50 }),
        fc.integer({ min: 18, max: 60 }),
        fc.constantFrom(203, 300),
        fc.constantFrom(40, 46, 48, 50.8),
        words(arabicWord),
        fc.option(words(latinWord), { nil: null }),
        barcodeData,
        fc.constantFrom<'ar' | 'en' | null>('ar', 'en', null),
        fc.boolean(),
        (w, h, dpi, printableWidthMm, nameAr, nameEn, data, language, vat) => {
          const layout = layoutLabel(
            geometry(w, h, dpi, printableWidthMm),
            text({
              nameAr,
              nameEn,
              barcode: barcodeFor(data)!,
              price: language
                ? {
                    language,
                    amount: '1,250.75',
                    currency: language === 'ar' ? 'درهم' : 'AED',
                    vatNote: vat ? (language === 'ar' ? 'شامل الضريبة' : 'incl. VAT') : null,
                  }
                : null,
            }),
            measurer,
          );
          if (layout.ok) expectSound(layout, printableWidthMm, dpi);
          // A long code on a narrow label is refused (the screen says so); a size from 25 mm high
          // always has room for everything.
          else if (layout.reason === 'too_small' && h >= 25) throw new Error(`refused ${w}×${h}`);
        },
      ),
      { numRuns: 400 },
    );
  });
});
