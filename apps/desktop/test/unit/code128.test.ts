/** M3-T9: the Code 128 (set B) encoder behind the barcode labels (decision 0043). */
import { describe, expect, it } from 'vitest';
import {
  canEncode,
  code128Bars,
  code128Values,
  code128Widths,
  PATTERNS,
  START_B,
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

  it('encodes an EAN-style barcode and an item code; refuses text outside set B', () => {
    const barcode = code128Values('6291100000012');
    expect(barcode).toHaveLength(13 + 3);
    expect(barcode[1]).toBe('6'.charCodeAt(0) - 32);
    expect(code128Bars('CHEM-0012').modules).toBe(11 * (9 + 2) + 13);
    expect(canEncode('CHEM-0012')).toBe(true);
    expect(canEncode('كلور')).toBe(false);
    expect(canEncode('')).toBe(false);
    expect(() => code128Values('كلور')).toThrow();
  });
});
