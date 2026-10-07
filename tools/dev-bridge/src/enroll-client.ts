/**
 * The PC side of enrollment protocol v1 (decision 0024). The Windows app does the same in Rust
 * (T11); both are checked against `db/test-vectors/enrollment.json`.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { hashRaw, type Algorithm } from '@node-rs/argon2';
import { ENROLL_ARGON2 } from '@artepool/shared/contracts';

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** What a person typed → the code as generated: capitals, ASCII digits, no spaces or dashes. */
export function normalizeCode(input: string): string {
  return input
    .replace(/[٠-٩۰-۹]/g, (d) => {
      const i = ARABIC_INDIC.indexOf(d);
      return String(i >= 0 ? i : EXTENDED_ARABIC_INDIC.indexOf(d));
    })
    .toUpperCase()
    .replace(/[\s\-_.]/g, '');
}

/** codeKey = Argon2id(normalized code, salt) with the fixed protocol settings. */
export function deriveCodeKey(code: string, salt: Buffer): Promise<Buffer> {
  return hashRaw(normalizeCode(code), {
    algorithm: 2 as Algorithm, // Argon2id
    memoryCost: ENROLL_ARGON2.memoryCost,
    timeCost: ENROLL_ARGON2.timeCost,
    parallelism: ENROLL_ARGON2.parallelism,
    outputLen: ENROLL_ARGON2.outputLength,
    salt,
  });
}

/** HMAC-SHA256 of a protocol message, base64url. */
export function proof(codeKey: Buffer, message: string): string {
  return createHmac('sha256', codeKey).update(message, 'utf8').digest('base64url');
}

/** Lower-case hex SHA-256 of the CA certificate as sent (PEM text, UTF-8). */
export function caFingerprint(caCertificatePem: string): string {
  return createHash('sha256').update(caCertificatePem, 'utf8').digest('hex');
}

/** 32 random bytes, base64url: nonces and device keys. */
export const random32 = (): string => randomBytes(32).toString('base64url');

/** What the server stores for a device key: its SHA-256, base64url. */
export const keyHash = (deviceKey: string): string =>
  createHash('sha256').update(deviceKey, 'utf8').digest('base64url');
