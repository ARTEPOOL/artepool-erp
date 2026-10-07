import { createHmac } from 'node:crypto';
import { hashRaw, type Algorithm } from '@node-rs/argon2';
import { ENROLL_ARGON2 } from '@artepool/shared/contracts';
import { normalizeCode } from '../../platform/crypto/codes';
import { sha256 } from '../../platform/crypto/tokens';

/** codeKey = Argon2id(normalized code, salt) with the fixed protocol settings (decision 0024). */
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
  return sha256(Buffer.from(caCertificatePem, 'utf8')).toString('hex');
}
