import { MoneyFormatError } from './errors';
import { FILS_DECIMALS, PRICE_DECIMALS, QUANTITY_DECIMALS } from './units';

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Converts Arabic-Indic / Persian digits and the Arabic decimal separator to plain ASCII. */
function toAsciiDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const arabic = ARABIC_INDIC.indexOf(ch);
    const persian = PERSIAN.indexOf(ch);
    if (arabic >= 0) out += String(arabic);
    else if (persian >= 0) out += String(persian);
    else if (ch === '٫') out += '.';
    else out += ch;
  }
  return out;
}

/** Parses a decimal text such as "100.5" into an integer with `decimals` implied places. Never uses floats. */
export function parseScaled(text: string, decimals: number): bigint {
  const match = DECIMAL.exec(toAsciiDigits(text.trim()));
  if (!match) {
    throw new MoneyFormatError(`Not a valid decimal number: "${text}"`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  if (fraction.length > decimals) {
    throw new MoneyFormatError(`Too many decimal places (at most ${decimals}): "${text}"`);
  }
  const value = BigInt(whole + fraction.padEnd(decimals, '0'));
  return sign ? -value : value;
}

/** Formats an integer with `decimals` implied places as plain text, e.g. 10050n, 2 → "100.50". */
export function formatScaled(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = decimals === 0 ? digits : digits.slice(0, -decimals);
  const fraction = decimals === 0 ? '' : `.${digits.slice(-decimals)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

export const parseFils = (text: string): bigint => parseScaled(text, FILS_DECIMALS);
export const formatFils = (value: bigint): string => formatScaled(value, FILS_DECIMALS);
export const parse4dp = (text: string): bigint => parseScaled(text, PRICE_DECIMALS);
export const format4dp = (value: bigint): string => formatScaled(value, PRICE_DECIMALS);
export const parseQuantity = (text: string): bigint => parseScaled(text, QUANTITY_DECIMALS);
export const formatQuantity = (value: bigint): string => formatScaled(value, QUANTITY_DECIMALS);
