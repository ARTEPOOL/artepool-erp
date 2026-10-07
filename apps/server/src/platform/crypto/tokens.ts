import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** A random opaque token (256 bits by default), URL-safe. Only its SHA-256 is ever stored. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Constant-time comparison; false when the lengths differ. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A uniformly random string from `alphabet` (no modulo bias). */
export function randomString(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}
