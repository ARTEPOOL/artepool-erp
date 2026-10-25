/**
 * Master-data rules shared by the screens and the server, so a value is judged the same way
 * everywhere (decisions 0032, 0037). The database enforces the same rules again.
 */
import { computeLine } from '../money/line';
import { formatScaled, parseScaled } from '../money/parse';
import { QUANTITY_DECIMALS, type Amount4dp, type BasisPoints, type Fils } from '../money/units';

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

/** Arabic-Indic and Persian digits → 0-9; everything else unchanged. */
export function asciiDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const arabic = ARABIC_INDIC.indexOf(ch);
    const persian = PERSIAN.indexOf(ch);
    out += arabic >= 0 ? String(arabic) : persian >= 0 ? String(persian) : ch;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Codes and barcodes
// ---------------------------------------------------------------------------------------------

/** Codes of items, customers, accounts…: letters, digits, `.`, `_`, `-`, 1–32 characters. */
export const CODE_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
/** Barcodes: 3–64 letters, digits, `.` or `-` (EAN/UPC and the shop's own codes). */
export const BARCODE_PATTERN = /^[0-9A-Za-z.-]{3,64}$/;

/** A code as stored: trimmed, Arabic digits made plain, letters in capitals. */
export function normalizeCode(text: string): string {
  return asciiDigits(text.trim()).toUpperCase();
}

/**
 * The next free code after the highest `PREFIX-<number>` among `existing` (e.g. CHEM-0012 →
 * CHEM-0013), keeping the width of the numbers already used (at least 4 digits).
 */
export function nextCode(prefix: string, existing: readonly string[]): string {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`, 'i');
  let highest = 0n;
  let width = 4;
  for (const code of existing) {
    const match = pattern.exec(code);
    if (!match?.[1]) continue;
    const value = BigInt(match[1]);
    if (value > highest) highest = value;
    width = Math.max(width, match[1].length);
  }
  return `${prefix.toUpperCase()}-${(highest + 1n).toString().padStart(width, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// TRN (UAE tax registration number) — decision 0037
// ---------------------------------------------------------------------------------------------

/** 15 digits starting with 100. */
export const TRN_PATTERN = /^100[0-9]{12}$/;

/** A TRN as typed (spaces, dashes, Arabic digits allowed) → 15 plain digits, or null if invalid. */
export function normalizeTrn(text: string): string | null {
  const digits = asciiDigits(text).replace(/[\s-]/g, '');
  return TRN_PATTERN.test(digits) ? digits : null;
}

// ---------------------------------------------------------------------------------------------
// UAE IBAN and SWIFT — decision 0065
// ---------------------------------------------------------------------------------------------

/** AE, 2 check digits, then 19 digits (3 for the bank, 16 for the account). */
export const UAE_IBAN_PATTERN = /^AE[0-9]{21}$/;
/** SWIFT/BIC: 4 letters (bank), 2 letters (country), 2 letters/digits, optional 3 for a branch. */
export const SWIFT_PATTERN = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** ISO 13616: move the first 4 characters to the end, letters → 10–35; the number mod 97 is 1. */
function ibanChecksumOk(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of rearranged) {
    const value = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

/** An IBAN as typed (spaces, lower case, Arabic digits allowed) → its saved form, or null. */
export function normalizeUaeIban(text: string): string | null {
  const iban = asciiDigits(text).replace(/[\s-]/g, '').toUpperCase();
  return UAE_IBAN_PATTERN.test(iban) && ibanChecksumOk(iban) ? iban : null;
}

/** "AE07 0331 2345 6789 0123 456": groups of 4, as printed on invoices. */
export const formatIban = (iban: string): string => iban.replace(/(.{4})(?=.)/g, '$1 ');

/** A SWIFT code as typed → upper case, or null if invalid. */
export function normalizeSwift(text: string): string | null {
  const swift = text.replace(/\s/g, '').toUpperCase();
  return SWIFT_PATTERN.test(swift) ? swift : null;
}

// ---------------------------------------------------------------------------------------------
// Phone numbers, stored in the international form (E.164)
// ---------------------------------------------------------------------------------------------

export const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

/**
 * A phone number as typed → `+971…` (or another country's `+…`), or null if it is not a valid
 * number. UAE numbers may be typed locally: `050 123 4567` → `+971501234567`, `03 765 4321` →
 * `+97137654321` (landline area codes 2, 3, 4, 6, 7, 9; mobiles 05…).
 */
export function normalizePhone(text: string): string | null {
  let value = asciiDigits(text.trim()).replace(/[\s().-]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (!value.startsWith('+')) {
    if (/^05[0-9]{8}$/.test(value) || /^0[234679][0-9]{7}$/.test(value)) {
      value = `+971${value.slice(1)}`;
    } else if (/^971[0-9]{8,9}$/.test(value)) {
      value = `+${value}`;
    } else {
      return null;
    }
  }
  if (!E164_PATTERN.test(value)) return null;
  if (value.startsWith('+971') && !/^\+971(5[0-9]{8}|[234679][0-9]{7})$/.test(value)) return null;
  return value;
}

/** `+971501234567` → `050 123 4567` for display; other numbers are shown as stored. */
export function formatPhone(e164: string): string {
  const mobile = /^\+9715([0-9])([0-9]{3})([0-9]{4})$/.exec(e164);
  if (mobile) return `05${mobile[1]} ${mobile[2]} ${mobile[3]}`;
  const landline = /^\+971([234679])([0-9]{3})([0-9]{4})$/.exec(e164);
  if (landline) return `0${landline[1]} ${landline[2]} ${landline[3]}`;
  return e164;
}

// ---------------------------------------------------------------------------------------------
// Quantities (thousandths) and units
// ---------------------------------------------------------------------------------------------

/** True when a quantity in thousandths has no more decimals than the unit allows (0–3). */
export function fitsUnitDecimals(quantityMilli: bigint, decimals: number): boolean {
  const step =
    10n ** BigInt(QUANTITY_DECIMALS - Math.min(Math.max(decimals, 0), QUANTITY_DECIMALS));
  return quantityMilli % step === 0n;
}

/** Database `numeric(14,3)` text ("5.000") → thousandths (5000n). */
export const quantityFromDb = (text: string): bigint => parseScaled(text, QUANTITY_DECIMALS);
/** Thousandths → database `numeric(14,3)` text. */
export const quantityToDb = (milli: bigint): string => formatScaled(milli, QUANTITY_DECIMALS);

// ---------------------------------------------------------------------------------------------
// Prices (decision 0032): one sale price with a "price includes VAT" switch
// ---------------------------------------------------------------------------------------------

export interface PriceBreakdown {
  /** For one unit, to the fils, exactly as an invoice line of quantity 1 would show it. */
  netFils: Fils;
  vatFils: Fils;
  grossFils: Fils;
}

/**
 * What one unit costs the customer: an inclusive price is split back into net and VAT, an
 * exclusive one gets VAT added (decision 0009), through the shared rounding helper.
 */
export function unitPriceBreakdown(
  price4dp: Amount4dp,
  includesVat: boolean,
  vatRateBp: BasisPoints,
): PriceBreakdown {
  const line = computeLine({
    quantity: 1000n,
    unitPrice4dp: price4dp,
    pricesIncludeVat: includesVat,
    vatRateBp,
  });
  return { netFils: line.netFils, vatFils: line.vatFils, grossFils: line.grossFils };
}

/**
 * A 4-decimal price for display: two decimals unless more were entered (12.5 → "12.50",
 * 1.2345 → "1.2345").
 */
export function formatPrice(price4dp: Amount4dp): string {
  const [whole, fraction = ''] = formatScaled(price4dp, 4).split('.');
  let digits = fraction;
  while (digits.length > 2 && digits.endsWith('0')) digits = digits.slice(0, -1);
  return `${whole}.${digits}`;
}
