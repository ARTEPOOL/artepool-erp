// @vitest-environment node
/**
 * The barcode label layout from the owner's design (decisions 0096, 0097): for every size, any design
 * (order, sizes, alignment, language, border, bar height, per-size overrides), short or very long
 * names, with or without the price, nothing overlaps, everything stays inside the printable width,
 * the barcode never goes below its minimum (5 mm bars, 2 dots per module at 203 dpi), and the price
 * reads in the right order. Text is measured here with an estimate a little larger than the real
 * fonts; the real fonts are checked in the browser (Playwright).
 */
import fc from 'fast-check';
import { readBarcodes } from 'zxing-wasm/reader';
import { describe, expect, it } from 'vitest';
import {
  defaultLabelDesign,
  designForSize,
  LABEL_ALIGNS,
  LABEL_ELEMENTS,
  LABEL_LANGUAGES,
  LABEL_SIZES,
  LabelDesign,
  type LabelElement,
} from '@artepool/shared/contracts';
import {
  layoutBoxes,
  layoutLabel,
  MIN_TEXT_MM,
  QUIET_EDGE_MM,
  TEXT_MM,
  wrapLines,
  type LabelContent,
  type LabelLayout,
  type LabelWords,
  type Measurer,
} from '../../src/features/items/labels/layout';

/**
 * A little larger than the app's real fonts measured in Chromium (GE SS TV: Arabic letters about
 * 0.39 em wide, up to 0.82 em above and 0.43 em below the baseline), so the checks have a safety margin.
 */
const measurer: Measurer = {
  width: (text, font, bold) =>
    [...text].reduce((sum, c) => {
      const em = c === ' ' ? 0.28 : c === '…' ? 0.9 : /[؀-ۿ]/.test(c) ? 0.5 : 0.56;
      return sum + em * font * (bold ? 1.06 : 1);
    }, 0),
  extent: (font, script) =>
    script === 'arabic'
      ? { ascent: font * 0.88, descent: font * 0.48 }
      : { ascent: font * 0.9, descent: font * 0.24 },
};

const WORDS: LabelWords = {
  currency: { ar: 'درهم', en: 'AED' },
  vat: { ar: 'شامل الضريبة', en: 'incl. VAT' },
  expiry: { ar: 'انتهاء', en: 'EXP' },
  batch: { ar: 'تشغيلة', en: 'LOT' },
};

const PRESETS = [
  ['50X30', 50, 30],
  ['50X25', 50, 25],
  ['40X30', 40, 30],
  ['38X25', 38, 25],
] as const;

const LONG_AR = 'كلور حبوب ٩٠٪ سريع الذوبان للمسابح الكبيرة والصغيرة عبوة ٥ كجم من إنتاج الشركة';

const content = (over: Partial<LabelContent> = {}): LabelContent => ({
  nameAr: 'كلور أقراص',
  nameEn: 'Chlorine tablets',
  itemCode: 'CHEM-0013',
  barcodeData: '6291041500213',
  pack: { ar: 'كيس 25 كجم', en: '25 kg bag' },
  shopName: { ar: 'آرتيبول', en: 'ARTEPOOL' },
  price: { amount: '120.00', includesVat: true },
  expiry: '2027-05-31',
  batch: 'A1234',
  printDate: '2026-10-20',
  ...over,
});

const geometry = (widthMm: number, heightMm: number, dpi = 203, printableWidthMm = 48) => ({
  widthMm,
  heightMm,
  dpi,
  printableWidthMm,
});

/** The default design with these elements shown (and everything else as the default). */
function designShowing(elements: LabelElement[], patch: Partial<LabelDesign> = {}): LabelDesign {
  const design = defaultLabelDesign();
  for (const e of elements) design.elements[e] = { ...design.elements[e], show: true };
  return { ...design, ...patch };
}

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The rules every printed label keeps. */
function expectSound(layout: LabelLayout, printableWidthMm: number, dpi: number) {
  const boxes = layoutBoxes(layout);
  const { content: area } = layout;
  // Inside the printable width (centred on the label), and inside the label's height.
  expect(area.w).toBeLessThanOrEqual(Math.round((printableWidthMm * dpi) / 25.4));
  expect(Math.abs(area.x * 2 + area.w - layout.widthDots)).toBeLessThanOrEqual(1);
  for (const { part, box } of boxes) {
    expect(box.x, part).toBeGreaterThanOrEqual(area.x);
    expect(box.x + box.w, part).toBeLessThanOrEqual(area.x + area.w);
    expect(box.y, part).toBeGreaterThanOrEqual(area.y);
    expect(box.y + box.h, part).toBeLessThanOrEqual(area.y + area.h);
  }
  // Nothing overlaps anything else.
  boxes.forEach((a, i) =>
    boxes
      .slice(i + 1)
      .forEach((b) => expect(overlap(a.box, b.box), `${a.part}/${b.part}`).toBe(false)),
  );
  // The Arabic name in 2 lines at most; letters never below the readable minimum.
  expect(layout.texts.filter((l) => l.part === 'nameAr').length).toBeLessThanOrEqual(2);
  for (const line of layout.texts) {
    expect(line.fontDots, line.part).toBeGreaterThanOrEqual(Math.round((MIN_TEXT_MM * dpi) / 25.4));
  }
  // The barcode never below its minimum: 5 mm bars, whole dots, at least 0.25 mm per module.
  expect(layout.bars.h).toBeGreaterThanOrEqual(Math.round((5 * dpi) / 25.4));
  expect(layout.bars.moduleDots).toBeGreaterThanOrEqual(dpi === 203 ? 2 : 3);
  for (const bar of layout.bars.rects) expect(bar.w % layout.bars.moduleDots).toBe(0);
  // The quiet zones (decision 0098): blank, 0.5 mm clear of the label's edge at least, inside the
  // border when there is one; the bars within them.
  const { quiet, box: bars, rects } = layout.bars;
  const edge = Math.round((QUIET_EDGE_MM * dpi) / 25.4);
  const lo = layout.border ? area.x : edge;
  const hi = layout.border ? area.x + area.w : layout.widthDots - edge;
  expect(quiet.x).toBeGreaterThanOrEqual(lo);
  expect(quiet.x + quiet.w).toBeLessThanOrEqual(hi);
  expect(rects[0]!.x - quiet.x).toBeGreaterThanOrEqual(bars.x - quiet.x);
  expect(rects[0]!.x).toBe(bars.x);
  expect(rects.at(-1)!.x + rects.at(-1)!.w).toBeLessThanOrEqual(bars.x + bars.w);
}

describe('wrapping the name', () => {
  it('keeps to the lines allowed and ends a cut name with "…"', () => {
    const wrapped = wrapLines(measurer, LONG_AR, 300, 24, true, 2);
    expect(wrapped.cut).toBe(true);
    expect(wrapped.lines).toHaveLength(2);
    expect(wrapped.lines[1]!.endsWith('…')).toBe(true);
    for (const line of wrapped.lines) {
      expect(measurer.width(line, 24, true)).toBeLessThanOrEqual(300);
    }
    expect(wrapLines(measurer, 'كلور', 300, 24, true, 2)).toEqual({ lines: ['كلور'], cut: false });
  });

  it('cuts one very long word too', () => {
    const wrapped = wrapLines(measurer, `${'ك'.repeat(80)} آخر`, 200, 24, true, 2);
    expect(wrapped.lines).toHaveLength(1);
    expect(measurer.width(wrapped.lines[0]!, 24, true)).toBeLessThanOrEqual(200);
  });
});

describe('the default design', () => {
  it.each(PRESETS)('%s fits a long Arabic name, the price and incl. VAT', (_code, w, h) => {
    for (const dpi of [203, 300]) {
      const layout = layoutLabel(
        geometry(w, h, dpi),
        defaultLabelDesign(),
        content({ nameAr: LONG_AR, expiry: null, batch: null }),
        WORDS,
        measurer,
      );
      expect(layout.ok).toBe(true);
      if (layout.ok) expectSound(layout, 48, dpi);
    }
  });

  it('expiry and batch as well: fit the 30 mm high labels, refused on 25 mm (no room)', () => {
    const all = content({ nameAr: LONG_AR });
    for (const [, w, h] of PRESETS) {
      const layout = layoutLabel(geometry(w, h), defaultLabelDesign(), all, WORDS, measurer);
      if (h >= 30) {
        expect(layout.ok).toBe(true);
        if (layout.ok) expectSound(layout, 48, 203);
      } else {
        expect(layout).toEqual({ ok: false, reason: 'too_small' });
      }
    }
  });

  it('50 × 30, short name: the design as drawn, EAN-13 bars of 3 dots', () => {
    const layout = layoutLabel(
      geometry(50, 30),
      defaultLabelDesign(),
      content({ expiry: null, batch: null }),
      WORDS,
      measurer,
    );
    if (!layout.ok) throw new Error('refused');
    expect(layout.fitted).toBe(false);
    expect(layout.texts[0]!.fontDots).toBe(Math.round((TEXT_MM.m * 203) / 25.4));
    expect(layout.bars.moduleDots).toBe(3);
    expect(layout.bars.h).toBe(Math.round((10 * 203) / 25.4));
    // The digits under the bars, "incl. VAT" because the price includes it.
    expect(layout.texts.map((l) => l.part)).toEqual(['nameAr', 'digits', 'vatNote']);
  });

  it('a tight size makes the bars shorter first (never below 5 mm), then the letters', () => {
    const layout = layoutLabel(
      geometry(50, 25),
      defaultLabelDesign(),
      content({ nameAr: LONG_AR, expiry: null, batch: null }),
      WORDS,
      measurer,
    );
    if (!layout.ok) throw new Error('refused');
    expect(layout.fitted).toBe(true);
    expect(layout.bars.h).toBeLessThan(Math.round((10 * 203) / 25.4));
    expect(layout.bars.h).toBeGreaterThanOrEqual(Math.round((5 * 203) / 25.4));
  });
});

describe('what the design decides', () => {
  it('shows the chosen elements in the chosen order', () => {
    const design = designShowing(
      ['nameEn', 'pack', 'itemCode', 'printDate', 'shopName', 'customText'],
      { customText: '04 123 4567' },
    );
    design.order = [
      'shopName',
      'nameAr',
      'nameEn',
      'pack',
      'barcode',
      'itemCode',
      'price',
      'vatNote',
      'expiry',
      'batch',
      'printDate',
      'customText',
    ];
    const layout = layoutLabel(geometry(50, 60), design, content(), WORDS, measurer);
    if (!layout.ok) throw new Error('refused');
    expect(layout.texts.map((l) => l.part)).toEqual([
      'shopName',
      'nameAr',
      'nameEn',
      'pack',
      'digits',
      'itemCode',
      'vatNote',
      'expiry',
      'batch',
      'printDate',
      'customText',
    ]);
    const tops = layout.texts.map((l) => l.box.y);
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    expect(layout.texts.find((l) => l.part === 'expiry')?.text).toBe('انتهاء 2027-05-31');
  });

  it('aligns right, centre or left inside the printable width', () => {
    const design = defaultLabelDesign();
    for (const align of LABEL_ALIGNS) {
      design.elements.nameAr = { ...design.elements.nameAr, align };
      const layout = layoutLabel(geometry(50, 30), design, content(), WORDS, measurer);
      if (!layout.ok) throw new Error('refused');
      const box = layout.texts[0]!.box;
      const area = layout.content;
      if (align === 'right') expect(box.x + box.w).toBe(area.x + area.w);
      if (align === 'left') expect(box.x).toBe(area.x);
      if (align === 'center') {
        expect(Math.abs(box.x + box.w / 2 - (area.x + area.w / 2))).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the price in Arabic, English or both, the number always to the right of the currency', () => {
    for (const language of LABEL_LANGUAGES) {
      const layout = layoutLabel(
        geometry(50, 40),
        { ...defaultLabelDesign(), language },
        content(),
        WORDS,
        measurer,
      );
      if (!layout.ok) throw new Error('refused');
      const currencies = layout.prices.map((p) => p.runs[0]!.text);
      expect(currencies).toEqual(
        language === 'ar' ? ['درهم'] : language === 'en' ? ['AED'] : ['درهم', 'AED'],
      );
      for (const line of layout.prices) {
        expect(line.runs[1]).toMatchObject({ text: '120.00', dir: 'ltr' });
        expect(line.runs[1]!.x).toBeGreaterThan(line.runs[0]!.x);
      }
    }
  });

  it('each element its own language; "both" = Arabic, then English under it (0101)', () => {
    const design = designShowing(['shopName', 'pack', 'nameEn']);
    design.language = 'both';
    design.elements.price = { ...design.elements.price, lang: 'en' };
    design.elements.pack = { ...design.elements.pack, lang: 'ar' };
    const layout = layoutLabel(
      geometry(50, 50),
      design,
      content({
        shopName: { ar: 'ارت لتجارة احواض السباحه', en: 'ARTE SWIMMING POOLS' },
        expiry: null,
        batch: null,
      }),
      WORDS,
      measurer,
    );
    if (!layout.ok) throw new Error(layout.reason);
    const lines = (part: string) => layout.texts.filter((l) => l.part === part);
    // The shop name: two lines, the English one under the Arabic one, never "ar / en" cut short.
    const shop = lines('shopName');
    expect(shop.map((l) => l.text)).toEqual(['ارت لتجارة احواض السباحه', 'ARTE SWIMMING POOLS']);
    expect(shop[1]!.box.y).toBeGreaterThan(shop[0]!.box.y);
    expect(shop.map((l) => l.dir)).toEqual(['rtl', 'ltr']);
    expect(layout.texts.some((l) => l.text.includes(' / '))).toBe(false);
    // The price in English only; the sale pack in Arabic only; "incl. VAT" as the design (both).
    expect(layout.prices.map((p) => p.runs.map((r) => r.text))).toEqual([['AED', '120.00']]);
    expect(lines('pack').map((l) => l.text)).toEqual(['كيس 25 كجم']);
    expect(lines('vatNote').map((l) => l.text)).toEqual(['شامل الضريبة', 'incl. VAT']);
    expectSound(layout, 48, 203);

    // A size can print another language: Arabic price on 40 × 30.
    const base = { ...defaultLabelDesign(), language: 'both' as const };
    base.overrides['40X30'] = { elements: { price: { lang: 'ar' } } };
    const small = layoutLabel(
      geometry(40, 30),
      designForSize(base, '40X30'),
      content({ expiry: null, batch: null }),
      WORDS,
      measurer,
    );
    if (!small.ok) throw new Error(small.reason);
    expect(small.prices.map((p) => p.runs[0]!.text)).toEqual(['درهم']);
  });

  it('"incl. VAT": always, when the price includes it, or never', () => {
    const vatOf = (vatNote: LabelDesign['vatNote'], includesVat: boolean) => {
      const layout = layoutLabel(
        geometry(50, 30),
        { ...defaultLabelDesign(), vatNote },
        content({ price: { amount: '13.13', includesVat } }),
        WORDS,
        measurer,
      );
      return layout.ok && layout.texts.some((l) => l.part === 'vatNote');
    };
    expect(vatOf('always', false)).toBe(true);
    expect(vatOf('whenIncluded', false)).toBe(false);
    expect(vatOf('whenIncluded', true)).toBe(true);
    expect(vatOf('never', true)).toBe(false);
  });

  it('the barcode is always printed, never below 5 mm; Code 128 when the design asks for it', () => {
    const design = defaultLabelDesign();
    design.elements.barcode = { ...design.elements.barcode, show: false };
    design.barcode = { heightMm: 5, showDigits: false, symbology: 'code128' };
    const layout = layoutLabel(geometry(50, 30), design, content(), WORDS, measurer);
    if (!layout.ok) throw new Error('refused');
    expect(layout.bars.h).toBe(Math.round((5 * 203) / 25.4));
    // EAN-13 data printed as Code 128 (start C, pairs of digits): not the 30 bars of an EAN-13.
    expect(layout.bars.rects.length).not.toBe(30);
    const tooShort = { ...design, barcode: { ...design.barcode, heightMm: 4 } };
    expect(LabelDesign.safeParse(tooShort).success).toBe(false);
  });

  it('a size override hides the English name on 40 × 30 only', () => {
    const design = designShowing(['nameEn']);
    const plain = content({ expiry: null, batch: null });
    design.overrides['40X30'] = { elements: { nameEn: { show: false } } };
    const on50 = layoutLabel(
      geometry(50, 30),
      designForSize(design, '50X30'),
      plain,
      WORDS,
      measurer,
    );
    const on40 = layoutLabel(
      geometry(40, 30),
      designForSize(design, '40X30'),
      plain,
      WORDS,
      measurer,
    );
    expect(on50.ok && on50.texts.some((l) => l.part === 'nameEn')).toBe(true);
    expect(on40.ok && on40.texts.some((l) => l.part === 'nameEn')).toBe(false);
  });

  it('refuses a label too small for the design, and a code too long for the width', () => {
    expect(layoutLabel(geometry(50, 12), defaultLabelDesign(), content(), WORDS, measurer)).toEqual(
      { ok: false, reason: 'too_small' },
    );
    expect(
      layoutLabel(
        geometry(25, 30),
        defaultLabelDesign(),
        content({ barcodeData: 'PUMP-HAYWARD-1.5HP' }),
        WORDS,
        measurer,
      ),
    ).toEqual({ ok: false, reason: 'barcode_too_long' });
  });
});

describe('the quiet zones may use the side margin (decision 0098)', () => {
  /** The bars as the label prints them: the label's whole width, white with black bars. */
  function barsImage(layout: LabelLayout) {
    const width = layout.widthDots;
    const height = 60;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (const bar of layout.bars.rects) {
      for (let y = 0; y < height; y += 1)
        data.fill(0, (y * width + bar.x) * 4, (y * width + bar.x + bar.w) * 4);
    }
    // Opaque: every 4th byte back to 255.
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return { data, width, height, colorSpace: 'srgb' as const };
  }

  it.each(['EQUIP-0001', 'CLEAN-0001'])(
    '40 × 30 at 203 dpi: %s as Code 128 at 2 dots per module, read back by a barcode reader',
    async (code) => {
      const layout = layoutLabel(
        geometry(40, 30),
        defaultLabelDesign(),
        content({ itemCode: code, barcodeData: code, expiry: null, batch: null }),
        WORDS,
        measurer,
      );
      if (!layout.ok) throw new Error(`refused: ${layout.reason}`);
      expectSound(layout, 48, 203);
      expect(layout.bars.moduleDots).toBe(2);
      // Wider than the content area with its quiet zones: they reach into the margin.
      expect(layout.bars.quiet.w).toBeGreaterThan(layout.content.w);
      const [found] = await readBarcodes(barsImage(layout), {
        formats: ['Code128'],
        tryHarder: false,
      });
      expect(found?.text).toBe(code);
    },
  );

  it('with a border the quiet zones stay inside it: then the 10-character code is refused', () => {
    const design = { ...defaultLabelDesign(), border: true };
    const result = layoutLabel(
      geometry(40, 30),
      design,
      content({ barcodeData: 'EQUIP-0001', expiry: null, batch: null }),
      WORDS,
      measurer,
    );
    expect(result).toEqual({ ok: false, reason: 'barcode_too_long' });
  });

  it('a code that still does not fit 40 × 30 is refused, and fits 50 × 30', () => {
    const long = content({ barcodeData: 'FILTER-00012', expiry: null, batch: null });
    expect(layoutLabel(geometry(40, 30), defaultLabelDesign(), long, WORDS, measurer)).toEqual({
      ok: false,
      reason: 'barcode_too_long',
    });
    const wide = layoutLabel(geometry(50, 30), defaultLabelDesign(), long, WORDS, measurer);
    expect(wide.ok).toBe(true);
    if (wide.ok) expectSound(wide, 48, 203);
  });
});

describe('property: any design, any size: never overlapping, never below the minimums', () => {
  const style = fc.record(
    {
      show: fc.boolean(),
      size: fc.constantFrom(...LABEL_SIZES),
      bold: fc.boolean(),
      align: fc.constantFrom(...LABEL_ALIGNS),
      // Each element's own language, or the design's (decision 0101).
      lang: fc.constantFrom(...LABEL_LANGUAGES),
    },
    { requiredKeys: ['show', 'size', 'bold', 'align'] },
  );
  const design: fc.Arbitrary<LabelDesign> = fc
    .record({
      order: fc.shuffledSubarray([...LABEL_ELEMENTS], {
        minLength: LABEL_ELEMENTS.length,
        maxLength: LABEL_ELEMENTS.length,
      }),
      elements: fc.record(
        Object.fromEntries(LABEL_ELEMENTS.map((e) => [e, style])) as Record<
          LabelElement,
          typeof style
        >,
      ),
      heightMm: fc.integer({ min: 10, max: 40 }).map((h) => h / 2),
      showDigits: fc.boolean(),
      code128: fc.boolean(),
      language: fc.constantFrom(...LABEL_LANGUAGES),
      vatNote: fc.constantFrom('always' as const, 'whenIncluded' as const, 'never' as const),
      side: fc.integer({ min: 1, max: 8 }).map((v) => v / 2),
      edge: fc.integer({ min: 1, max: 8 }).map((v) => v / 2),
      border: fc.boolean(),
    })
    .map((r): LabelDesign => ({
      order: r.order,
      elements: r.elements,
      barcode: {
        heightMm: r.heightMm,
        showDigits: r.showDigits,
        symbology: r.code128 ? 'code128' : 'auto',
      },
      language: r.language,
      vatNote: r.vatNote,
      customText: 'هاتف 04 123 4567',
      marginsMm: { side: r.side, edge: r.edge },
      border: r.border,
      overrides: {},
    }));
  const arabicWord = fc.stringMatching(/^[ء-ي]{1,12}$/);
  const latinWord = fc.stringMatching(/^[A-Za-z0-9%.,-]{1,14}$/);
  const words = (word: fc.Arbitrary<string>) =>
    fc.array(word, { minLength: 1, maxLength: 18 }).map((w) => w.join(' '));

  it('lays out soundly or refuses', () => {
    fc.assert(
      fc.property(
        design,
        fc.integer({ min: 30, max: 50 }),
        fc.integer({ min: 18, max: 60 }),
        fc.constantFrom(203, 300),
        fc.constantFrom(40, 46, 48, 50.8),
        words(arabicWord),
        fc.option(words(latinWord), { nil: null }),
        fc.constantFrom('6291041500213', '036000291452', 'CHEM-0013', 'X001JBWYZV'),
        fc.boolean(),
        (d, w, h, dpi, printableWidthMm, nameAr, nameEn, barcodeData, priced) => {
          const layout = layoutLabel(
            geometry(w, h, dpi, printableWidthMm),
            d,
            content({
              nameAr,
              nameEn,
              barcodeData,
              price: priced ? { amount: '1,250.75', includesVat: true } : null,
            }),
            WORDS,
            measurer,
          );
          if (layout.ok) expectSound(layout, printableWidthMm, dpi);
        },
      ),
      { numRuns: 500 },
    );
  });
});
