/**
 * The update signature check (decisions 0007, 0108) against a file signed by Tauri's own signer
 * (a throwaway test key; only its public half is kept): the right file passes; a changed byte,
 * another key, a changed trusted comment or rubbish is refused.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SignatureError,
  verifyFileSignature,
  verifySignature,
} from '../../src/cli/updater/signature';

const dir = join(import.meta.dirname, '..', 'fixtures', 'update-signature');
const publicKey = readFileSync(join(dir, 'test.key.pub'), 'utf8');
const signature = readFileSync(join(dir, 'data.bin.sig'), 'utf8');
const data = readFileSync(join(dir, 'data.bin'));

const b64 = (text: string) => Buffer.from(text).toString('base64');

/** Another key, in the same format, for the "signed by someone else" case. */
function otherKey(): { publicKey: string; signature: string } {
  const pair = generateKeyPairSync('ed25519');
  const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const keyId = Buffer.from('0102030405060708', 'hex');
  const pub = Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64');
  const sig = sign(null, data, pair.privateKey);
  const sigBlob = Buffer.concat([Buffer.from('Ed'), keyId, sig]).toString('base64');
  const comment = 'timestamp:1 file:data.bin';
  const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), pair.privateKey);
  return {
    publicKey: b64(`untrusted comment: other\n${pub}\n`),
    signature: b64(
      `untrusted comment: other\n${sigBlob}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`,
    ),
  };
}

describe('the update signature', () => {
  it("accepts a file signed by Tauri's signer with the update key", () => {
    expect(() => verifySignature(publicKey, signature, data)).not.toThrow();
  });

  it('checks a file read in pieces the same way', async () => {
    await expect(
      verifyFileSignature(publicKey, signature, join(dir, 'data.bin')),
    ).resolves.toBeUndefined();
    await expect(
      verifyFileSignature(publicKey, signature, join(dir, 'test.key.pub')),
    ).rejects.toThrow(SignatureError);
  });

  it('refuses a changed file', () => {
    const changed = Buffer.from(data);
    changed[0] = changed[0]! ^ 1;
    expect(() => verifySignature(publicKey, signature, changed)).toThrow(SignatureError);
  });

  it('refuses a file signed with another key, even with that key alone valid', () => {
    const other = otherKey();
    expect(() => verifySignature(other.publicKey, other.signature, data)).not.toThrow();
    expect(() => verifySignature(publicKey, other.signature, data)).toThrow(/another key/);
  });

  it('refuses a changed trusted comment', () => {
    const text = Buffer.from(signature, 'base64').toString('utf8');
    const forged = b64(text.replace('file:data.bin', 'file:other.bin'));
    expect(() => verifySignature(publicKey, forged, data)).toThrow(/trusted comment/);
  });

  it('refuses rubbish keys and signatures', () => {
    expect(() => verifySignature('', signature, data)).toThrow(SignatureError);
    expect(() => verifySignature(publicKey, b64('nothing here'), data)).toThrow(SignatureError);
  });
});
