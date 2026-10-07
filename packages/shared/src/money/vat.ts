import { roundDiv } from './round';
import { BASIS_POINTS, type BasisPoints, type Fils } from './units';

function assertRate(rateBp: BasisPoints): void {
  if (rateBp < 0n || rateBp > BASIS_POINTS) {
    throw new RangeError(`VAT rate must be between 0 and 10000 basis points, got ${rateBp}`);
  }
}

/** VAT on a net (tax-exclusive) amount: net × rate, rounded to the fils (decision 0009). */
export function vatOnNet(netFils: Fils, rateBp: BasisPoints): Fils {
  assertRate(rateBp);
  return roundDiv(netFils * rateBp, BASIS_POINTS);
}

/** VAT contained in a gross (tax-inclusive) amount: gross × rate ÷ (100% + rate), rounded to the fils. */
export function vatInGross(grossFils: Fils, rateBp: BasisPoints): Fils {
  assertRate(rateBp);
  return roundDiv(grossFils * rateBp, BASIS_POINTS + rateBp);
}
