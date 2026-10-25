/**
 * The barcode printed on a label (decision 0096). A supplier barcode that is a real EAN-13, UPC-A or
 * EAN-8 (correct GS1 check digit) stays that symbology, as retail scanners expect; anything else
 * (the item code, an internal barcode) is printed as Code 128. Widths are in modules; the label
 * layout then gives each module a whole number of printer dots, so every bar prints the same.
 */
import { canEncode, code128Widths } from './code128';

export type Symbology = 'ean13' | 'upca' | 'ean8' | 'code128';

export interface Barcode {
  symbology: Symbology;
  /** What a scanner reads, and the text printed under the bars. */
  data: string;
  /** Bar, space, bar, … widths in modules, starting with a bar. */
  widths: number[];
  /** Total width of the bars and spaces, in modules. */
  modules: number;
  /** Blank margins each side, in modules (GS1: EAN-13 11/7, UPC-A 9/9, EAN-8 7/7; Code 128 10/10). */
  quiet: { left: number; right: number };
}

/** The GS1 check digit for the digits before it (weights 3, 1, 3, … from the right). */
export function gs1CheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** True for 8, 12 or 13 digits whose last digit is the right GS1 check digit. */
export function isValidGtin(text: string): boolean {
  return (
    /^(\d{8}|\d{12}|\d{13})$/.test(text) && gs1CheckDigit(text.slice(0, -1)) === Number(text.at(-1))
  );
}

/** Left-hand (odd parity) digit patterns, as space-bar-space-bar widths; right-hand = the same widths bar first. */
// prettier-ignore
const L_CODES = ['3211', '2221', '2122', '1411', '1132', '1231', '1114', '1312', '1213', '3112'];
/** Which left-hand digits of an EAN-13 use the even-parity (G = reversed) patterns, by the first digit. */
// prettier-ignore
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

const digitWidths = (digit: string, reversed = false) => {
  const widths = [...L_CODES[Number(digit)]!].map(Number);
  return reversed ? widths.reverse() : widths;
};

/** EAN-13 / EAN-8 bars: guard, left digits, centre guard, right digits, guard (95 / 67 modules). */
function eanWidths(digits: string): number[] {
  const ean13 = digits.length === 13;
  const left = ean13 ? digits.slice(1, 7) : digits.slice(0, 4);
  const right = ean13 ? digits.slice(7) : digits.slice(4);
  const parity = ean13 ? PARITY[Number(digits[0])]! : 'LLLL';
  return [
    1,
    1,
    1,
    ...[...left].flatMap((d, i) => digitWidths(d, parity[i] === 'G')),
    1,
    1,
    1,
    1,
    1,
    ...[...right].flatMap((d) => digitWidths(d)),
    1,
    1,
    1,
  ];
}

const total = (widths: number[]) => widths.reduce((a, b) => a + b, 0);

/**
 * The barcode for this text, or null when it cannot be printed (letters outside ASCII). A real
 * EAN-13 / UPC-A / EAN-8 stays so, unless `code128` asks for Code 128 always.
 */
export function barcodeFor(data: string, options: { code128?: boolean } = {}): Barcode | null {
  // The design may ask for Code 128 always (decision 0097).
  if (!options.code128 && isValidGtin(data)) {
    if (data.length === 13) {
      const widths = eanWidths(data);
      return {
        symbology: 'ean13',
        data,
        widths,
        modules: total(widths),
        quiet: { left: 11, right: 7 },
      };
    }
    if (data.length === 12) {
      // UPC-A is an EAN-13 that starts with 0.
      const widths = eanWidths(`0${data}`);
      return {
        symbology: 'upca',
        data,
        widths,
        modules: total(widths),
        quiet: { left: 9, right: 9 },
      };
    }
    const widths = eanWidths(data);
    return {
      symbology: 'ean8',
      data,
      widths,
      modules: total(widths),
      quiet: { left: 7, right: 7 },
    };
  }
  if (!canEncode(data)) return null;
  const widths = code128Widths(data);
  return {
    symbology: 'code128',
    data,
    widths,
    modules: total(widths),
    quiet: { left: 10, right: 10 },
  };
}

/** Narrowest and widest module (mm): 0.25 is GS1's 75% EAN for thermal printing; 0.4 keeps it compact. */
export const MODULE_MM = { min: 0.25, max: 0.4 } as const;

/** Width of the bars with their quiet zones, in modules. */
export const fullModules = (barcode: Barcode) =>
  barcode.modules + barcode.quiet.left + barcode.quiet.right;

/**
 * Printer dots per module: the widest whole number that fits the space (with quiet zones) and stays
 * within MODULE_MM; null when even the narrowest does not fit. `barsDots`, when given, is the
 * narrower space the bars themselves must keep to (the quiet zones may go beyond it, decision 0098).
 */
export function moduleDots(
  barcode: Barcode,
  availableDots: number,
  dpi: number,
  barsDots = availableDots,
): number | null {
  const dotsPerMm = dpi / 25.4;
  // A small tolerance: 2 dots at 203 dpi (0.2502 mm) count as 0.25 mm.
  const min = Math.max(1, Math.ceil(MODULE_MM.min * dotsPerMm - 0.01));
  const max = Math.max(min, Math.floor(MODULE_MM.max * dotsPerMm + 0.01));
  const fits = Math.min(
    Math.floor(availableDots / fullModules(barcode)),
    Math.floor(barsDots / barcode.modules),
  );
  const dots = Math.min(fits, max);
  return dots >= min ? dots : null;
}

/** The bars as rectangles in dots, the quiet zone included from `x` (the left edge of the zone). */
export function barRects(barcode: Barcode, dots: number, x = 0): { x: number; w: number }[] {
  const rects: { x: number; w: number }[] = [];
  let at = x + barcode.quiet.left * dots;
  barcode.widths.forEach((w, i) => {
    if (i % 2 === 0) rects.push({ x: at, w: w * dots });
    at += w * dots;
  });
  return rects;
}
