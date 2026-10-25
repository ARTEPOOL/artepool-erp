/**
 * The off-site copy's contents (decision 0102): the database copy and the master key, encrypted
 * together for the owner's backup key; only the private key opens it; a changed byte or another
 * key is refused with a plain reason; plain database copies (older off-site copies, the external
 * drive) still open, without a master key.
 */
import { randomBytes } from 'node:crypto';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { describe, expect, it } from 'vitest';
import { BundleError, encryptBundle, openCopy } from '../../src/bundle';

const dump = Buffer.concat([Buffer.from('PGDMP'), randomBytes(5000)]);
const masterKey = randomBytes(32);

async function keys() {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

const reasonOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof BundleError ? error.reason : String(error)),
  );

describe('the encrypted copy', () => {
  it('carries the database copy and the master key; only the private key opens it', async () => {
    const { identity, recipient } = await keys();
    const sealed = await encryptBundle(
      dump,
      'artepool-20261022-010000Z.dump',
      masterKey,
      recipient,
    );
    expect(sealed.includes(masterKey)).toBe(false);
    expect(sealed.includes(dump.subarray(0, 64))).toBe(false);
    const opened = await openCopy(sealed, identity);
    expect(opened.dump.equals(dump)).toBe(true);
    expect(opened.masterKey!.equals(masterKey)).toBe(true);
    expect(opened.dumpName).toBe('artepool-20261022-010000Z.dump');

    const other = await keys();
    expect(await reasonOf(openCopy(sealed, other.identity))).toBe('wrong_key');
    expect(await reasonOf(openCopy(sealed, null))).toBe('wrong_key');
    expect(await reasonOf(openCopy(sealed, 'not a key'))).toBe('wrong_key');
  });

  it('refuses a changed copy', async () => {
    const { identity, recipient } = await keys();
    const sealed = await encryptBundle(dump, 'x.dump', masterKey, recipient);
    const changed = Buffer.from(sealed);
    changed[changed.length - 10]! ^= 1;
    // age itself notices (authenticated encryption), so the key "does not open this copy".
    expect(await reasonOf(openCopy(changed, identity))).toBe('wrong_key');
  });

  it('opens a plain database copy as it is, without a master key', async () => {
    const opened = await openCopy(dump, null);
    expect(opened).toEqual({ dump, masterKey: null, dumpName: null });
    expect(await reasonOf(openCopy(Buffer.from('hello, this is not a copy'), null))).toBe(
      'not_a_copy',
    );
  });
});
