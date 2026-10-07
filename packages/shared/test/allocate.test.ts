import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateDocumentDiscount, allocateProportionally, MoneyRuleError } from '../src/money';

describe('discount allocation (largest remainder)', () => {
  it('splits 10.00 across three equal lines as 3.34 + 3.33 + 3.33', () => {
    expect(allocateDocumentDiscount(1000n, [5000n, 5000n, 5000n])).toEqual([334n, 333n, 333n]);
  });

  it('splits in proportion to line value', () => {
    expect(allocateDocumentDiscount(1000n, [30000n, 10000n])).toEqual([750n, 250n]);
  });

  it('handles zero discount and zero-value lines', () => {
    expect(allocateDocumentDiscount(0n, [100n, 0n])).toEqual([0n, 0n]);
    expect(allocateDocumentDiscount(100n, [100n, 0n])).toEqual([100n, 0n]);
    expect(allocateProportionally(0n, [0n, 0n])).toEqual([0n, 0n]);
  });

  it('refuses a discount larger than the document', () => {
    expect(() => allocateDocumentDiscount(201n, [100n, 100n])).toThrow(MoneyRuleError);
    expect(() => allocateProportionally(1n, [0n])).toThrow(MoneyRuleError);
  });

  it('always adds up exactly, never exceeds a line, never goes negative', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt(0n, 10n ** 9n), { minLength: 1, maxLength: 40 }), (lines) => {
        const total = lines.reduce((a, b) => a + b, 0n);
        fc.pre(total > 0n);
        const discount = total / 3n;
        const shares = allocateDocumentDiscount(discount, lines);
        expect(shares.reduce((a, b) => a + b, 0n)).toBe(discount);
        shares.forEach((share, i) => {
          expect(share >= 0n).toBe(true);
          expect(share <= (lines[i] ?? 0n)).toBe(true);
        });
        expect(allocateDocumentDiscount(discount, lines)).toEqual(shares);
      }),
    );
  });
});
