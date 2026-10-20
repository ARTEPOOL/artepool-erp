/** The Code 128 encoder behind the barcode labels (decisions 0043, 0096): set B, set C for digits. */
import { describe, expect, it } from 'vitest';
import {
  canEncode,
  code128Bars,
  code128Values,
  code128Widths,
  CODE_B,
  CODE_C,
  PATTERNS,
  START_B,
  START_C,
  STOP,
} from '../../src/features/items/labels/code128';

const sum = (widths: number[]) => widths.reduce((a, b) => a + b, 0);

describe('Code 128 encoder', () => {
  it('has the 107 standard patterns: 11 modules each (13 for stop), bars even, all different', () => {
    expect(PATTERNS).toHaveLength(107);
    PATTERNS.forEach((pattern, value) => {
      const widths = [...pattern].map(Number);
      expect(sum(widths)).toBe(value === STOP ? 13 : 11);
      // Bars (odd positions) always add up to an even number of modules.
      expect(sum(widths.filter((_, i) => i % 2 === 0)) % 2).toBe(0);
    });
    expect(new Set(PATTERNS).size).toBe(107);
    expect(PATTERNS[0]).toBe('212222');
    expect(PATTERNS[START_B]).toBe('211214');
    expect(PATTERNS[STOP]).toBe('2331112');
  });

  it('encodes "PJJ123C" with the weighted modulo-103 check symbol', () => {
    // 104 + 48×1 + 42×2 + 42×3 + 17×4 + 18×5 + 19×6 + 35×7 = 879; 879 mod 103 = 55.
    expect(code128Values('PJJ123C')).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
  });

  it('turns "A" into start B, A, check 34 and stop, as bar and space widths', () => {
    expect(code128Values('A')).toEqual([104, 33, 34, 106]);
    expect(code128Widths('A').join('')).toBe('211214' + '111323' + '131123' + '2331112');
    const { bars, modules } = code128Bars('A');
    expect(modules).toBe(11 * 3 + 13);
    expect(bars[0]).toEqual({ x: 0, w: 2 });
    // The stop pattern ends with a 2-module bar right at the end.
    expect(bars.at(-1)).toEqual({ x: modules - 2, w: 2 });
  });

  it('packs digits two by two in set C: a numeric barcode is about half as wide', () => {
    // Only digits, odd count: start C, six pairs, Code B, the last digit, check, stop.
    const barcode = code128Values('6291100000012');
    expect(barcode.slice(0, 9)).toEqual([
      START_C,
      62,
      91,
      10,
      0,
      0,
      1,
      CODE_B,
      '2'.charCodeAt(0) - 32,
    ]);
    expect(barcode).toHaveLength(11);
    expect(code128Bars('6291100000012').modules).toBe(11 * 10 + 13);
    expect(code128Values('123456')).toEqual([START_C, 12, 34, 56, expect.any(Number), STOP]);
  });

  it('switches to set C for long runs of digits, keeping an odd first digit in set B', () => {
    // Four digits at the end: "CHEM-" in B, then 00 12 in C.
    expect(code128Values('CHEM-0012').slice(0, 9)).toEqual([
      START_B,
      35,
      40,
      37,
      45,
      13,
      CODE_C,
      0,
      12,
    ]);
    // Five digits at the end: the first one stays in B.
    expect(code128Values('A12345').slice(0, 6)).toEqual([START_B, 33, 17, CODE_C, 23, 45]);
    // Three digits in the middle are not worth a switch.
    expect(code128Values('AB123CD')).toHaveLength(7 + 3);
    // The check symbol counts every symbol after the start, weighted by position.
    const values = code128Values('CHEM-0012');
    const check = values.slice(0, -2).reduce((s, v, i) => s + v * Math.max(i, 1), 0) % 103;
    expect(values.at(-2)).toBe(check);
  });

  it('refuses text outside printable ASCII', () => {
    expect(canEncode('CHEM-0012')).toBe(true);
    expect(canEncode('كلور')).toBe(false);
    expect(canEncode('')).toBe(false);
    expect(() => code128Values('كلور')).toThrow();
  });
});
