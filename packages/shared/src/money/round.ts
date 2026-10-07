/**
 * Integer division rounded half away from zero.
 *
 * This is the single rounding rule of ARTÉPOOL ERP (golden rule 1, decision 0014).
 * The database uses the same rule in `sys.round_div`; both pass db/test-vectors/rounding.json.
 */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError('roundDiv: division by zero');
  }
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let quotient = n / d;
  if ((n % d) * 2n >= d) {
    quotient += 1n;
  }
  return negative ? -quotient : quotient;
}
