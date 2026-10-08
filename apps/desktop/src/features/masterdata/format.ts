/**
 * Showing amounts: always exact (integers from the server, never floats), with Western digits
 * inside <bdi> so they read the same in Arabic and English.
 */
import { formatFils, formatPrice, unitPriceBreakdown } from '@artepool/shared';

/** 123456n fils → "1,234.56". */
export function money(fils: bigint): string {
  const [whole = '0', fraction = '00'] = formatFils(fils).split('.');
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  return `${negative ? '-' : ''}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

/** A 4-decimal price as text: two decimals unless more were entered. */
export function price(price4dp: bigint): string {
  const [whole = '0', fraction = ''] = formatPrice(price4dp).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

/** 500 basis points → "5%". */
export function rate(rateBp: number): string {
  const whole = Math.trunc(rateBp / 100);
  const rest = rateBp % 100;
  return `${whole}${rest ? `.${String(rest).padStart(2, '0').replace(/0$/, '')}` : ''}%`;
}

/** One unit with VAT and without, from the item's one price and its switch (decision 0032). */
export function priceBoth(price4dp: bigint, includesVat: boolean, vatRateBp: number) {
  return unitPriceBreakdown(price4dp, includesVat, BigInt(vatRateBp));
}
