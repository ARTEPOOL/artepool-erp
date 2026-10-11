/**
 * Profit per unit from the sale price and the purchase price (decision 0038), shown to the owner
 * next to the item. Both sides are without VAT: the sale price is split with the shared helper,
 * the purchase price is entered without VAT. Whole numbers only; the percentage is the profit as
 * a share of the sale price without VAT, in tenths of a percent.
 */
import { roundDiv } from '@artepool/shared';

export interface Margin {
  /** Profit per unit in fils (negative = selling below cost). */
  profitFils: bigint;
  /** Profit ÷ sale price without VAT, in tenths of a percent (235 = 23.5%); null if the price is 0. */
  tenthsOfPercent: bigint | null;
}

export function marginOf(netFils: bigint, cost4dp: bigint): Margin {
  const costFils = roundDiv(cost4dp, 100n);
  const profitFils = netFils - costFils;
  return {
    profitFils,
    tenthsOfPercent: netFils === 0n ? null : roundDiv(profitFils * 1000n, netFils),
  };
}

/** 235n → "23.5%", -50n → "-5.0%". */
export function percentText(tenths: bigint): string {
  const negative = tenths < 0n;
  const abs = negative ? -tenths : tenths;
  return `${negative ? '-' : ''}${abs / 10n}.${abs % 10n}%`;
}
