import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseFils, vatInGross, vatOnNet } from '../src/money';
import { sharedVectors } from './vectors';

describe('VAT per line (decision 0009)', () => {
  it.each(sharedVectors.vat_inclusive)(
    'VAT inside $gross at $rate_bp bp is $vat',
    ({ gross, rate_bp, vat }) => {
      expect(vatInGross(parseFils(gross), BigInt(rate_bp))).toBe(parseFils(vat));
    },
  );

  it.each(sharedVectors.vat_exclusive)(
    'VAT on $net at $rate_bp bp is $vat',
    ({ net, rate_bp, vat }) => {
      expect(vatOnNet(parseFils(net), BigInt(rate_bp))).toBe(parseFils(vat));
    },
  );

  it('never takes more VAT out of a gross amount than the amount itself', () => {
    fc.assert(
      fc.property(fc.bigInt(0n, 10n ** 12n), fc.bigInt(0n, 10_000n), (gross, rate) => {
        const vat = vatInGross(gross, rate);
        expect(vat >= 0n && vat <= gross).toBe(true);
      }),
    );
  });

  it('rejects impossible rates', () => {
    expect(() => vatOnNet(100n, -1n)).toThrow(RangeError);
    expect(() => vatInGross(100n, 10_001n)).toThrow(RangeError);
  });
});
