import { Secret, TOTP } from 'otpauth';
import { asciiDigits } from '../crypto/codes';

/** Standard authenticator-app settings (Google / Microsoft Authenticator): SHA-1, 6 digits, 30 s. */
const PERIOD_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'ARTEPOOL';

const totpFor = (secretBase32: string, label = 'user'): TOTP =>
  new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(secretBase32),
  });

/** A new random 160-bit secret, as base32 (what the QR code carries). */
export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** The `otpauth://` link shown as a QR code during 2-step setup. */
export function totpUri(secretBase32: string, username: string): string {
  return totpFor(secretBase32, username).toString();
}

/** The current code for a secret (used only by tests and the setup check). */
export function totpCode(secretBase32: string, timestampMs = Date.now()): string {
  return totpFor(secretBase32).generate({ timestamp: timestampMs });
}

/**
 * Checks a 6-digit code, allowing one step of clock difference either way. Returns the time
 * step the code belongs to, or null. A code is accepted only if its step is later than
 * `lastStep`, so the same code (or an older one) can never be used twice.
 */
export function verifyTotp(
  secretBase32: string,
  input: string,
  lastStep: bigint | null,
  timestampMs = Date.now(),
): bigint | null {
  const code = asciiDigits(input).replace(/\s/g, '');
  if (!/^[0-9]{6}$/.test(code)) return null;
  const delta = totpFor(secretBase32).validate({ token: code, timestamp: timestampMs, window: 1 });
  if (delta === null) return null;
  const step = BigInt(Math.floor(timestampMs / 1000 / PERIOD_SECONDS) + delta);
  return lastStep !== null && step <= lastStep ? null : step;
}
