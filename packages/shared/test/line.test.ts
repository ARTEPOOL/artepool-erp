import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeLine,
  lineAmountFils,
  MoneyRuleError,
  parse4dp,
  parseFils,
  parseQuantity,
} from '../src/money';
import { sharedVectors } from './vectors';

describe('line amounts', () => {
  it.each(sharedVectors.line_amount)(
    '$quantity × $unit_price = $amount',
    ({ quantity, unit_price, amount }) => {
      expect(lineAmountFils(parseQuantity(quantity), parse4dp(unit_price))).toBe(parseFils(amount));
    },
  );

  it('VAT-inclusive price: 9.99 AED at 5% → VAT 0.48, net 9.51', () => {
    const line = computeLine({
      quantity: 1000n,
      unitPrice4dp: parse4dp('9.99'),
      pricesIncludeVat: true,
      vatRateBp: 500n,
    });
    expect(line).toMatchObject({ grossFils: 999n, vatFils: 48n, netFils: 951n });
  });

  it('VAT-exclusive price with discounts: 3 × 100 AED, 20 + 10 AED off → net 270, VAT 13.50', () => {
    const line = computeLine({
      quantity: 3000n,
      unitPrice4dp: parse4dp('100'),
      pricesIncludeVat: false,
      vatRateBp: 500n,
      lineDiscountFils: 2000n,
      docDiscountAllocFils: 1000n,
    });
    expect(line).toEqual({
      amountBeforeDiscountFils: 30000n,
      lineDiscountFils: 2000n,
      docDiscountAllocFils: 1000n,
      discountExclVatFils: 3000n,
      netFils: 27000n,
      vatFils: 1350n,
      grossFils: 28350n,
    });
  });

  it('expresses an inclusive discount excluding VAT for reports', () => {
    const line = computeLine({
      quantity: 1000n,
      unitPrice4dp: parse4dp('105'),
      pricesIncludeVat: true,
      vatRateBp: 500n,
      lineDiscountFils: 1050n,
    });
    expect(line.discountExclVatFils).toBe(1000n);
    expect(line.grossFils).toBe(9450n);
    expect(line.vatFils).toBe(450n);
  });

  it('refuses a discount larger than the line, negative values and zero quantity', () => {
    const base = {
      quantity: 1000n,
      unitPrice4dp: 10000n,
      pricesIncludeVat: false,
      vatRateBp: 500n,
    };
    expect(() => computeLine({ ...base, lineDiscountFils: 101n })).toThrow(MoneyRuleError);
    expect(() => computeLine({ ...base, lineDiscountFils: -1n })).toThrow(MoneyRuleError);
    expect(() => computeLine({ ...base, quantity: 0n })).toThrow(MoneyRuleError);
    expect(() => computeLine({ ...base, unitPrice4dp: -1n })).toThrow(MoneyRuleError);
  });

  it('always satisfies net + VAT = gross, with nothing negative', () => {
    fc.assert(
      fc.property(
        fc.bigInt(1n, 1_000_000n),
        fc.bigInt(0n, 100_000_000n),
        fc.boolean(),
        fc.constantFrom(0n, 500n),
        fc.integer({ min: 0, max: 100 }),
        (quantity, unitPrice4dp, pricesIncludeVat, vatRateBp, discountPct) => {
          const amount = lineAmountFils(quantity, unitPrice4dp);
          const lineDiscountFils = (amount * BigInt(discountPct)) / 100n;
          const line = computeLine({
            quantity,
            unitPrice4dp,
            pricesIncludeVat,
            vatRateBp,
            lineDiscountFils,
          });
          expect(line.netFils + line.vatFils).toBe(line.grossFils);
          expect(line.netFils >= 0n && line.vatFils >= 0n).toBe(true);
          expect(line.discountExclVatFils <= lineDiscountFils).toBe(true);
        },
      ),
    );
  });
});
