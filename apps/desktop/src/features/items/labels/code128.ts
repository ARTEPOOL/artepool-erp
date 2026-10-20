/**
 * A small Code 128 encoder for barcode labels (decisions 0043, 0096). It turns text into the widths
 * of alternating bars and spaces, in modules, starting with a bar: a start symbol, the data, the
 * check symbol (weighted sum modulo 103), then the stop pattern. Set B covers printable ASCII
 * (space to `~`), which includes every item code and barcode; runs of digits switch to set C, which
 * packs two digits into one symbol, so a numeric code is about half as wide.
 */

/** The 107 Code 128 patterns: values 0–102, start A/B/C (103–105) and stop (106). */
// prettier-ignore
export const PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212',
  '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221',
  '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221',
  '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321',
  '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131',
  '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131',
  '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111',
  '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242',
  '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311',
  '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

/** "Code C" in set B and "Code B" in set C: switch the set for the symbols that follow. */
export const CODE_C = 99;
export const CODE_B = 100;
export const START_B = 104;
export const START_C = 105;
export const STOP = 106;

/** True when every character can be drawn (set B, with set C for digits). */
export function canEncode(text: string): boolean {
  return text.length > 0 && [...text].every((c) => c >= ' ' && c <= '~');
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** How many digits follow from position `i`. */
function digitRun(text: string, i: number): number {
  let n = 0;
  while (isDigit(text[i + n])) n += 1;
  return n;
}

/**
 * The symbol values: start, the data, the check symbol, stop. Set C is used where it makes the code
 * shorter: from the start when the text begins with 4 or more digits (or is only digits), and for 6
 * or more digits in a row (4 at the end). An odd run keeps its first digit in set B.
 */
export function code128Values(text: string): number[] {
  if (!canEncode(text)) throw new Error('Code 128: unsupported text');
  const first = digitRun(text, 0);
  let inC = first === text.length ? first >= 2 : first >= 4;
  const values = [inC ? START_C : START_B];
  let i = 0;
  while (i < text.length) {
    if (inC) {
      if (digitRun(text, i) >= 2) {
        values.push(Number(text.slice(i, i + 2)));
        i += 2;
      } else {
        values.push(CODE_B);
        inC = false;
      }
      continue;
    }
    const run = digitRun(text, i);
    if (run >= 6 || (run >= 4 && i + run === text.length)) {
      if (run % 2 === 1) {
        values.push(text.charCodeAt(i) - 32);
        i += 1;
      }
      values.push(CODE_C);
      inC = true;
      continue;
    }
    values.push(text.charCodeAt(i) - 32);
    i += 1;
  }
  const check = values.reduce((sum, value, position) => sum + value * Math.max(position, 1), 0);
  return [...values, check % 103, STOP];
}

/** Bar and space widths in modules, starting with a bar (11 per symbol, 13 for the stop). */
export function code128Widths(text: string): number[] {
  return code128Values(text).flatMap((value) => [...PATTERNS[value]!].map(Number));
}

/** The bars only: where each starts (in modules) and how wide it is, plus the total width. */
export function code128Bars(text: string): { bars: { x: number; w: number }[]; modules: number } {
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  code128Widths(text).forEach((w, i) => {
    if (i % 2 === 0) bars.push({ x, w });
    x += w;
  });
  return { bars, modules: x };
}
