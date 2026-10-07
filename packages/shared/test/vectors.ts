import vectors from '../../../db/test-vectors/rounding.json';

export interface Vectors {
  round_div: { n: string; d: string; q: string }[];
  vat_inclusive: { gross: string; rate_bp: string; vat: string }[];
  vat_exclusive: { net: string; rate_bp: string; vat: string }[];
  line_amount: { quantity: string; unit_price: string; amount: string }[];
}

export const sharedVectors: Vectors = vectors;
