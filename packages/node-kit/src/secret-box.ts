import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

const VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBoxError extends Error {
  override readonly name = 'SecretBoxError';
}

/**
 * Encrypts small secrets for storage (the owner's 2-step secret, later integration keys) with
 * AES-256-GCM. The master key never enters the database or its backups (architecture §6).
 *
 * Sealed format: version (1 byte) ‖ nonce (12) ‖ ciphertext ‖ tag (16). The `aad` string binds a
 * sealed value to its place (for example `auth.users.totp_secret_enc:42`), so it cannot be copied
 * to another row and still open.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  static fromKey(key: Buffer): SecretBox {
    if (key.length !== KEY_BYTES) {
      throw new SecretBoxError(`The master key must be ${KEY_BYTES} bytes.`);
    }
    return new SecretBox(Buffer.from(key));
  }

  /**
   * Reads a master key file (base64 of 32 random bytes, created by `pnpm dev:secrets` in
   * development only; the installed server gets the key from the launcher, see `fromSource`). On Linux and macOS the
   * file must not be readable by other users.
   */
  static async fromFile(path: string): Promise<SecretBox> {
    let text: string;
    try {
      if (process.platform !== 'win32' && ((await stat(path)).mode & 0o077) !== 0) {
        throw new SecretBoxError(
          `The master key file ${path} is readable by other users. Run: chmod 600 "${path}"`,
        );
      }
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (error instanceof SecretBoxError) throw error;
      throw new SecretBoxError(
        `The master key file ${path} could not be read. In development, run: pnpm dev:secrets`,
        { cause: error },
      );
    }
    const key = Buffer.from(text.trim(), 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== text.trim()) {
      throw new SecretBoxError(`The master key file ${path} is not a valid 32-byte key.`);
    }
    return SecretBox.fromKey(key);
  }

  /** From a file (development) or from the key the launcher gave (installed server). */
  static async fromSource(source: { file: string } | { key: Buffer }): Promise<SecretBox> {
    return 'key' in source ? SecretBox.fromKey(source.key) : SecretBox.fromFile(source.file);
  }

  seal(plaintext: Buffer, aad: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.of(VERSION), nonce, body, cipher.getAuthTag()]);
  }

  /** Throws SecretBoxError if the value was changed, belongs elsewhere, or uses another key. */
  open(sealed: Buffer, aad: string): Buffer {
    if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES || sealed[0] !== VERSION) {
      throw new SecretBoxError('The sealed secret has an unknown format.');
    }
    const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const body = sealed.subarray(1 + NONCE_BYTES, sealed.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch (error) {
      throw new SecretBoxError('The sealed secret could not be opened.', { cause: error });
    }
  }
}
