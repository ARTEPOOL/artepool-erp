import { describe, expect, it } from 'vitest';
import { marginOf, percentText } from '../../src/features/items/margin';

describe('profit per unit', () => {
  it('is the sale price without VAT minus the purchase price', () => {
    // Sells at 100.00 without VAT, bought at 76.50: profit 23.50 = 23.5% of the price.
    expect(marginOf(10000n, 765000n)).toEqual({ profitFils: 2350n, tenthsOfPercent: 235n });
  });

  it('can be a loss, and is exact with 4-decimal purchase prices', () => {
    expect(marginOf(1000n, 123456n)).toEqual({ profitFils: -235n, tenthsOfPercent: -235n });
    expect(percentText(-235n)).toBe('-23.5%');
    expect(percentText(235n)).toBe('23.5%');
    expect(percentText(50n)).toBe('5.0%');
  });

  it('has no percentage when the price is zero', () => {
    expect(marginOf(0n, 10000n).tenthsOfPercent).toBeNull();
  });
});
