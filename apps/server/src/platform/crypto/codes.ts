import { randomString } from './tokens';

/**
 * Characters for codes that people read and type: digits and capital letters without the
 * look-alikes 0/O, 1/I/L (decision 0024). 31 characters ≈ 4.95 bits each.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const group = (length: number, groups: number): string =>
  Array.from({ length: groups }, () => randomString(CODE_ALPHABET, length)).join('-');

/** Device enrollment code: `XXX-XXX-XXX` (≈ 44.6 bits; single use, 10 minutes, 5 tries). */
export const newEnrollmentCode = (): string => group(3, 3);

/** Owner 2-step recovery code: `XXXXX-XXXXX` (≈ 49.5 bits; stored as Argon2id). */
export const newRecoveryCode = (): string => group(5, 2);

/** Temporary password from the owner: `XXXX-XXXX-XXXX` (≈ 59 bits); changed at first sign-in. */
export const newTemporaryPassword = (): string => group(4, 3);

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** Turns Arabic-Indic digits (٠-٩, ۰-۹) into 0-9, so codes work from an Arabic keyboard too. */
export function asciiDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => {
    const i = ARABIC_INDIC.indexOf(d);
    return String(i >= 0 ? i : EXTENDED_ARABIC_INDIC.indexOf(d));
  });
}

/** What a person typed → the code as generated: capitals, ASCII digits, no spaces or dashes. */
export function normalizeCode(input: string): string {
  return asciiDigits(input)
    .toUpperCase()
    .replace(/[\s\-_.]/g, '');
}
