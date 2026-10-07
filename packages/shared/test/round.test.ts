import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { roundDiv } from '../src/money';
import { sharedVectors } from './vectors';

describe('roundDiv (half away from zero)', () => {
  it.each(sharedVectors.round_div)('$n / $d = $q', ({ n, d, q }) => {
    expect(roundDiv(BigInt(n), BigInt(d))).toBe(BigInt(q));
  });

  it('refuses division by zero', () => {
    expect(() => roundDiv(1n, 0n)).toThrow(RangeError);
  });

  it('is never more than half a unit away from the exact result', () => {
    fc.assert(
      fc.property(fc.bigInt(-(10n ** 18n), 10n ** 18n), fc.bigInt(1n, 10n ** 9n), (n, d) => {
        const q = roundDiv(n, d);
        const error = q * d - n;
        expect((error < 0n ? -error : error) * 2n <= d).toBe(true);
      }),
    );
  });

  it('is symmetric for negative values (refunds round like sales)', () => {
    fc.assert(
      fc.property(fc.bigInt(-(10n ** 18n), 10n ** 18n), fc.bigInt(1n, 10n ** 9n), (n, d) => {
        expect(roundDiv(-n, d)).toBe(-roundDiv(n, d));
        expect(roundDiv(n, -d)).toBe(-roundDiv(n, d));
      }),
    );
  });
});
