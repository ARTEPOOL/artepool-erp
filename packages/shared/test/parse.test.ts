import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  format4dp,
  formatFils,
  formatQuantity,
  MoneyFormatError,
  parse4dp,
  parseFils,
  parseQuantity,
} from '../src/money';

describe('parsing and formatting amounts', () => {
  it('parses fils exactly, without floating point', () => {
    expect(parseFils('100.50')).toBe(10050n);
    expect(parseFils('100.5')).toBe(10050n);
    expect(parseFils('0.1')).toBe(10n);
    expect(parseFils('-3.70')).toBe(-370n);
    expect(parseFils('  42 ')).toBe(4200n);
  });

  it('accepts Arabic-Indic digits and the Arabic decimal separator', () => {
    expect(parseFils('١٠٠٫٥٠')).toBe(10050n);
    expect(parseFils('۱۲.۳۴')).toBe(1234n);
  });

  it('rejects too many decimals and non-numbers', () => {
    for (const bad of ['1.234', '1e3', '', '.5', '1,000.00', 'abc', '1.2.3', 'NaN']) {
      expect(() => parseFils(bad)).toThrow(MoneyFormatError);
    }
    expect(() => parse4dp('1.23456')).toThrow(MoneyFormatError);
    expect(() => parseQuantity('2.5000')).toThrow(MoneyFormatError);
  });

  it('formats with fixed decimals', () => {
    expect(formatFils(10050n)).toBe('100.50');
    expect(formatFils(5n)).toBe('0.05');
    expect(formatFils(-5n)).toBe('-0.05');
    expect(formatFils(0n)).toBe('0.00');
    expect(format4dp(12345n)).toBe('1.2345');
    expect(formatQuantity(2500n)).toBe('2.500');
  });

  it('round-trips every value', () => {
    fc.assert(
      fc.property(fc.bigInt(-(10n ** 15n), 10n ** 15n), (v) => {
        expect(parseFils(formatFils(v))).toBe(v);
        expect(parse4dp(format4dp(v))).toBe(v);
        expect(parseQuantity(formatQuantity(v))).toBe(v);
      }),
    );
  });
});
