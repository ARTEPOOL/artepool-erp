import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asciiDigits,
  CODE_ALPHABET,
  newEnrollmentCode,
  newRecoveryCode,
  newTemporaryPassword,
  normalizeCode,
} from '../../src/platform/crypto/codes';
import { ARGON2_PARAMS, SecretHasher } from '../../src/platform/crypto/hashing';
import { SecretBox, SecretBoxError } from '../../src/platform/crypto/secret-box';
import { newToken, randomString, safeEqual, sha256 } from '../../src/platform/crypto/tokens';

describe('SecretHasher (Argon2id)', () => {
  const hasher = new SecretHasher();

  it('uses the production cost: 64 MiB, 3 passes', async () => {
    expect(ARGON2_PARAMS).toEqual({ memoryCost: 65_536, timeCost: 3, parallelism: 1 });
    const hashed = await hasher.hash('correct horse battery');
    expect(hashed).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(hashed).not.toContain('correct horse');
  });

  it('accepts only the right secret, and treats composed and decomposed letters alike', async () => {
    const hashed = await hasher.hash('Café-Al-Ain-2026');
    expect(await hasher.verify(hashed, 'Café-Al-Ain-2026')).toBe(true);
    expect(await hasher.verify(hashed, 'Café-Al-Ain-2026')).toBe(true);
    expect(await hasher.verify(hashed, 'café-al-ain-2026')).toBe(false);
  });

  it('never throws on a malformed hash, and spends the same effort when there is no hash', async () => {
    expect(await hasher.verify('plain text', 'plain text')).toBe(false);
    expect(await hasher.verify('$argon2id$v=19$m=1,t=1,p=1$xx$yy', 'x')).toBe(false);
    expect(await hasher.verifyOrDummy(null, 'anything')).toBe(false);
  });

  it('asks for a rehash when the cost has been raised', async () => {
    const cheap = new SecretHasher({ memoryCost: 8192, timeCost: 1, parallelism: 1 });
    const old = await cheap.hash('a long enough secret');
    expect(hasher.needsRehash(old)).toBe(true);
    expect(hasher.needsRehash(await hasher.hash('a long enough secret'))).toBe(false);
    expect(await hasher.verify(old, 'a long enough secret')).toBe(true);
  });
});

describe('SecretBox (AES-256-GCM)', () => {
  const box = SecretBox.fromKey(Buffer.alloc(32, 7));
  const secret = Buffer.from('JBSWY3DPEHPK3PXP');

  it('opens what it sealed, with a fresh nonce every time', () => {
    const a = box.seal(secret, 'auth.users.totp_secret_enc:42');
    const b = box.seal(secret, 'auth.users.totp_secret_enc:42');
    expect(a.equals(b)).toBe(false);
    expect(a[0]).toBe(1);
    expect(a.includes(secret)).toBe(false);
    expect(box.open(a, 'auth.users.totp_secret_enc:42').equals(secret)).toBe(true);
  });

  it('refuses a value moved to another row, edited, or opened with another key', () => {
    const sealed = box.seal(secret, 'auth.users.totp_secret_enc:42');
    expect(() => box.open(sealed, 'auth.users.totp_secret_enc:43')).toThrow(SecretBoxError);
    const edited = Buffer.from(sealed);
    edited[20] = edited[20]! ^ 1;
    expect(() => box.open(edited, 'auth.users.totp_secret_enc:42')).toThrow(SecretBoxError);
    const other = SecretBox.fromKey(Buffer.alloc(32, 8));
    expect(() => other.open(sealed, 'auth.users.totp_secret_enc:42')).toThrow(SecretBoxError);
    expect(() => box.open(Buffer.from([1, 2, 3]), 'x')).toThrow(SecretBoxError);
    expect(() => SecretBox.fromKey(Buffer.alloc(16))).toThrow(SecretBoxError);
  });

  describe('key file', () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'artepool-key-'));
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    it('loads a private 32-byte key and refuses anything else', async () => {
      const good = join(dir, 'good.key');
      await writeFile(good, `${Buffer.alloc(32, 9).toString('base64')}\n`, { mode: 0o600 });
      const loaded = await SecretBox.fromFile(good);
      expect(loaded.open(loaded.seal(secret, 'a'), 'a').equals(secret)).toBe(true);

      const short = join(dir, 'short.key');
      await writeFile(short, Buffer.alloc(16).toString('base64'), { mode: 0o600 });
      await expect(SecretBox.fromFile(short)).rejects.toThrow(/not a valid 32-byte key/);
      await expect(SecretBox.fromFile(join(dir, 'missing.key'))).rejects.toThrow(
        /pnpm dev:secrets/,
      );
      if (process.platform !== 'win32') {
        await chmod(good, 0o644);
        await expect(SecretBox.fromFile(good)).rejects.toThrow(/readable by other users/);
      }
    });
  });
});

describe('tokens and codes', () => {
  it('makes 256-bit URL-safe tokens and stores only their SHA-256', () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(token);
    expect(sha256(token)).toHaveLength(32);
    expect(safeEqual(sha256(token), sha256(token))).toBe(true);
    expect(safeEqual(sha256(token), sha256('other'))).toBe(false);
    expect(safeEqual(Buffer.alloc(2), Buffer.alloc(3))).toBe(false);
  });

  it('uses only unambiguous characters in codes people type', () => {
    expect(CODE_ALPHABET).toHaveLength(31);
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
    expect(newEnrollmentCode()).toMatch(
      /^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/,
    );
    expect(newRecoveryCode()).toMatch(/^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
    expect(newTemporaryPassword()).toMatch(/^([2-9A-HJKMNP-Z]{4}-){2}[2-9A-HJKMNP-Z]{4}$/);
  });

  it('reads codes the way people type them', () => {
    expect(normalizeCode(' k7q-4mx 92p ')).toBe('K7Q4MX92P');
    expect(asciiDigits('٤٨٢٩ ۱۲۳')).toBe('4829 123');
    fc.assert(
      fc.property(fc.constant(null), () => {
        const code = newEnrollmentCode();
        return normalizeCode(code.toLowerCase()) === code.replaceAll('-', '');
      }),
      { numRuns: 200 },
    );
  });

  it('draws characters uniformly', () => {
    const counts = new Map<string, number>();
    for (const c of randomString('ABCD', 40_000)) counts.set(c, (counts.get(c) ?? 0) + 1);
    for (const n of counts.values()) expect(Math.abs(n - 10_000)).toBeLessThan(600);
  });
});
