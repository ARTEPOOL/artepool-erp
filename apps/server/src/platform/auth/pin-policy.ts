import { asciiDigits } from '../crypto/codes';
import { randomString } from '../crypto/tokens';

/** Why a PIN was refused (decision 0021). The app translates each one. */
export type PinProblem = 'not_four_digits' | 'weak';

/** Very common PINs that are not caught by the pattern rules below. */
const COMMON_PINS = new Set(['2580', '0852', '1004', '2000', '2001', '6969']);

/** A PIN as typed (Arabic or Western digits, stray spaces) → four ASCII digits. */
export function normalizePin(input: string): string {
  return asciiDigits(input).replace(/\s/g, '');
}

/**
 * Weak PINs: one digit repeated (0000), a straight run up or down including wrap-around
 * (1234, 7890, 9876), a repeated pair (1212), doubled digits (1122), or a very common PIN.
 */
export function isWeakPin(pin: string): boolean {
  const d = [...pin].map(Number);
  const [a, b, c, e] = d as [number, number, number, number];
  const steps = [b - a, c - b, e - c].map((s) => (s + 10) % 10);
  return (
    steps.every((s) => s === 0) ||
    steps.every((s) => s === 1) ||
    steps.every((s) => s === 9) ||
    (a === c && b === e) ||
    (a === b && c === e) ||
    COMMON_PINS.has(pin)
  );
}

/** Returns an empty list when the PIN is exactly four digits and not weak. */
export function checkPin(pin: string): PinProblem[] {
  if (!/^[0-9]{4}$/.test(pin)) return ['not_four_digits'];
  return isWeakPin(pin) ? ['weak'] : [];
}

/** A random temporary PIN that passes the rules; the user replaces it at the next sign-in. */
export function newTemporaryPin(): string {
  for (;;) {
    const pin = randomString('0123456789', 4);
    if (!isWeakPin(pin)) return pin;
  }
}
