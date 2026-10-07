import { MoneyRuleError } from './errors';
import { roundDiv } from './round';
import type { Amount4dp, BasisPoints, Fils, QuantityMilli } from './units';
import { vatInGross, vatOnNet } from './vat';

/** quantity (3 decimals) × unit price (4 decimals) = 7 decimals; fils have 2, so divide by 10^5. */
const QTY_TIMES_PRICE_TO_FILS = 100_000n;

/** Line amount before discount: quantity × unit price, rounded to the fils. */
export function lineAmountFils(quantity: QuantityMilli, unitPrice4dp: Amount4dp): Fils {
  return roundDiv(quantity * unitPrice4dp, QTY_TIMES_PRICE_TO_FILS);
}

export interface LineInput {
  quantity: QuantityMilli;
  unitPrice4dp: Amount4dp;
  pricesIncludeVat: boolean;
  vatRateBp: BasisPoints;
  /** Discount on this line, on the same basis as the price (incl. or excl. VAT). */
  lineDiscountFils?: Fils;
  /** This line's share of the document discount (see allocateDocumentDiscount). */
  docDiscountAllocFils?: Fils;
}

export interface LineAmounts {
  amountBeforeDiscountFils: Fils;
  lineDiscountFils: Fils;
  docDiscountAllocFils: Fils;
  /** Total discount on this line expressed excluding VAT (for discount reports). */
  discountExclVatFils: Fils;
  netFils: Fils;
  vatFils: Fils;
  grossFils: Fils;
}

/**
 * Computes one invoice line (decisions 0009, 0012, 0014): VAT is calculated per line,
 * discounts reduce the line before VAT, and every amount is exact to the fils.
 */
export function computeLine(input: LineInput): LineAmounts {
  const lineDiscountFils = input.lineDiscountFils ?? 0n;
  const docDiscountAllocFils = input.docDiscountAllocFils ?? 0n;
  if (input.quantity <= 0n) throw new MoneyRuleError('Quantity must be greater than zero');
  if (input.unitPrice4dp < 0n) throw new MoneyRuleError('Unit price cannot be negative');
  if (lineDiscountFils < 0n || docDiscountAllocFils < 0n) {
    throw new MoneyRuleError('Discounts cannot be negative');
  }

  const amountBeforeDiscountFils = lineAmountFils(input.quantity, input.unitPrice4dp);
  const discount = lineDiscountFils + docDiscountAllocFils;
  if (discount > amountBeforeDiscountFils) {
    throw new MoneyRuleError('The discount is larger than the line amount');
  }
  const afterDiscount = amountBeforeDiscountFils - discount;

  if (input.pricesIncludeVat) {
    const grossFils = afterDiscount;
    const vatFils = vatInGross(grossFils, input.vatRateBp);
    return {
      amountBeforeDiscountFils,
      lineDiscountFils,
      docDiscountAllocFils,
      discountExclVatFils: discount - vatInGross(discount, input.vatRateBp),
      netFils: grossFils - vatFils,
      vatFils,
      grossFils,
    };
  }

  const netFils = afterDiscount;
  const vatFils = vatOnNet(netFils, input.vatRateBp);
  return {
    amountBeforeDiscountFils,
    lineDiscountFils,
    docDiscountAllocFils,
    discountExclVatFils: discount,
    netFils,
    vatFils,
    grossFils: netFils + vatFils,
  };
}
