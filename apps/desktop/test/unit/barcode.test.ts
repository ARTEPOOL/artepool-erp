// @vitest-environment node
/**
 * Label barcodes (decision 0096): supplier EAN-13 / UPC-A / EAN-8 stay so, everything else is
 * Code 128; bars are whole printer dots with blank quiet zones. Every barcode is drawn at the
 * printer's dots and read back with a real barcode reader (ZXing) at 203 and 300 dpi.
 */
import fc from 'fast-check';
import { readBarcodes } from 'zxing-wasm/reader';
import { describe, expect, it } from 'vitest';
import {
  barcodeFor,
  barRects,
  fullModules,
  gs1CheckDigit,
  isValidGtin,
  moduleDots,
  type Barcode,
} from '../../src/features/items/labels/barcode';

/** 48 mm, the printable width of a 2-inch printer, in dots. */
const printable = (dpi: number) => Math.floor((48 * dpi) / 25.4);

/** The barcode as an image (black bars on white), the way the label draws it. */
function draw(barcode: Barcode, dots: number, height = 80) {
  const width = fullModules(barcode) * dots;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const bar of barRects(barcode, dots)) {
    for (let y = 0; y < height; y += 1) {
      for (let x = bar.x; x < bar.x + bar.w; x += 1)
        data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
  }
  return { data, width, height, colorSpace: 'srgb' as const };
}

/** The reader's names for the symbologies. */
const FORMAT = { ean13: 'EAN13', upca: 'UPCA', ean8: 'EAN8', code128: 'Code128' } as const;

const LOOK_FOR = { ean13: 'EAN-13', upca: 'UPC-A', ean8: 'EAN-8', code128: 'Code128' } as const;

async function scan(barcode: Barcode, dpi: number) {
  const dots = moduleDots(barcode, printable(dpi), dpi);
  expect(dots).not.toBeNull();
  // A UPC-A is an EAN-13 starting with 0: the reader is told which one to look for.
  const [found] = await readBarcodes(draw(barcode, dots!), {
    formats: [LOOK_FOR[barcode.symbology]],
    tryHarder: false,
  });
  // This reader writes a UPC-A as its 13-digit EAN form (a leading 0).
  const text = found?.format === 'UPCA' ? found.text.replace(/^0(\d{12})$/, '$1') : found?.text;
  return { format: found?.format, text };
}

describe('GS1 check digits', () => {
  it('match the published examples', () => {
    expect(gs1CheckDigit('400638133393')).toBe(1); // EAN-13 4006381333931
    expect(gs1CheckDigit('03600029145')).toBe(2); // UPC-A 036000291452
    expect(gs1CheckDigit('9638507')).toBe(4); // EAN-8 96385074
    expect(isValidGtin('4006381333931')).toBe(true);
    expect(isValidGtin('4006381333932')).toBe(false);
    expect(isValidGtin('CHEM-0012')).toBe(false);
  });
});

describe('choosing the symbology', () => {
  it('keeps real EAN/UPC barcodes; prints anything else as Code 128', () => {
    expect(barcodeFor('4006381333931')).toMatchObject({
      symbology: 'ean13',
      modules: 95,
      quiet: { left: 11, right: 7 },
    });
    expect(barcodeFor('036000291452')).toMatchObject({
      symbology: 'upca',
      modules: 95,
      quiet: { left: 9, right: 9 },
    });
    expect(barcodeFor('96385074')).toMatchObject({
      symbology: 'ean8',
      modules: 67,
      quiet: { left: 7, right: 7 },
    });
    // A wrong check digit is not an EAN: Code 128 prints it exactly as stored.
    expect(barcodeFor('4006381333932')?.symbology).toBe('code128');
    expect(barcodeFor('CHEM-0012')).toMatchObject({
      symbology: 'code128',
      quiet: { left: 10, right: 10 },
    });
    expect(barcodeFor('كلور')).toBeNull();
  });

  it('bars and spaces alternate and add up to the symbol width', () => {
    for (const data of ['4006381333931', '036000291452', '96385074', 'CHEM-0012']) {
      const barcode = barcodeFor(data)!;
      expect(barcode.widths.reduce((a, b) => a + b, 0)).toBe(barcode.modules);
      expect(barcode.widths.length % 2).toBe(1); // starts and ends with a bar
    }
  });
});

describe('whole printer dots', () => {
  it('gives EAN-13 3 dots (0.375 mm) on 48 mm at 203 dpi, 2 dots on a 40 mm label', () => {
    const ean = barcodeFor('6291041500213')!;
    expect(moduleDots(ean, printable(203), 203)).toBe(3);
    expect(moduleDots(ean, Math.floor((38 * 203) / 25.4), 203)).toBe(2);
    expect(moduleDots(ean, printable(300), 300)).toBe(4);
    // Too narrow for 0.25 mm bars: refused, never squeezed.
    expect(moduleDots(ean, 150, 203)).toBeNull();
  });

  it('every bar is a whole number of dots and the quiet zones stay blank', () => {
    const barcode = barcodeFor('CHEM-0012')!;
    const dots = moduleDots(barcode, printable(203), 203)!;
    const rects = barRects(barcode, dots);
    for (const r of rects) {
      expect(Number.isInteger(r.x) && Number.isInteger(r.w)).toBe(true);
      expect(r.w % dots).toBe(0);
    }
    expect(rects[0]!.x).toBe(barcode.quiet.left * dots);
    const last = rects.at(-1)!;
    expect(fullModules(barcode) * dots - (last.x + last.w)).toBe(barcode.quiet.right * dots);
  });
});

describe('a barcode reader reads what is printed', () => {
  it.each([203, 300])('supplier barcodes and item codes at %i dpi', async (dpi) => {
    for (const data of [
      '6291041500213',
      '4006381333931',
      '036000291452',
      '96385074',
      'CHEM-0012',
      '123456',
      'PUMP-A1',
    ]) {
      const barcode = barcodeFor(data)!;
      expect(await scan(barcode, dpi)).toEqual({ format: FORMAT[barcode.symbology], text: data });
    }
  });

  it('any item code or valid EAN-13 reads back exactly (property test)', async () => {
    const code = fc.stringMatching(/^[A-Z0-9][A-Z0-9.-]{0,11}$/);
    const ean = fc.stringMatching(/^\d{12}$/).map((body) => `${body}${gs1CheckDigit(body)}`);
    await fc.assert(
      fc.asyncProperty(fc.oneof(code, ean), fc.constantFrom(203, 300), async (data, dpi) => {
        const barcode = barcodeFor(data)!;
        const dots = moduleDots(barcode, printable(dpi), dpi);
        if (dots === null) return; // too long for 48 mm: the label screen refuses it
        expect(await scan(barcode, dpi)).toEqual({ format: FORMAT[barcode.symbology], text: data });
      }),
      { numRuns: 150 },
    );
  });
});
