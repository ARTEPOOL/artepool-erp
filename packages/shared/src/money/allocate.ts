import { MoneyRuleError } from './errors';
import type { Fils } from './units';

/**
 * Splits `total` across `weights` in proportion, so the parts always add up exactly to `total`
 * (largest-remainder method). Leftover fils go to the largest remainders; ties go to the earlier line.
 */
export function allocateProportionally(total: bigint, weights: readonly bigint[]): bigint[] {
  if (total < 0n) throw new MoneyRuleError('Cannot allocate a negative amount');
  if (weights.some((w) => w < 0n)) throw new MoneyRuleError('Weights cannot be negative');
  const sum = weights.reduce((acc, w) => acc + w, 0n);
  if (sum === 0n) {
    if (total === 0n) return weights.map(() => 0n);
    throw new MoneyRuleError('Cannot allocate an amount across lines worth zero');
  }

  const shares = weights.map((w) => (total * w) / sum);
  let left = total - shares.reduce((acc, s) => acc + s, 0n);
  const order = weights
    .map((w, index) => ({ index, remainder: (total * w) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (const { index } of order) {
    if (left === 0n) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    left -= 1n;
  }
  return shares;
}

/** Spreads a document-level discount across the lines before VAT (decision 0012). */
export function allocateDocumentDiscount(
  discountFils: Fils,
  lineAmountsFils: readonly Fils[],
): Fils[] {
  const total = lineAmountsFils.reduce((acc, a) => acc + a, 0n);
  if (discountFils > total) {
    throw new MoneyRuleError('The discount is larger than the document total');
  }
  return allocateProportionally(discountFils, lineAmountsFils);
}
