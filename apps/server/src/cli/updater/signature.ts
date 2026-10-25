/**
 * The update signature check (decisions 0007, 0108). Every installer the release workflow
 * publishes is signed with the update key (Tauri's signer, minisign format). The desktop app's
 * updater checks the office installer; the server PC's updater checks the server installer here
 * with the same public key, before anything is run.
 *
 * Both the public key and the signature are given as Tauri gives them: base64 of the minisign
 * text. A signature is accepted only when it was made by that key, over exactly these bytes, and
 * its trusted comment is intact.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Ed25519 public key as DER (SubjectPublicKeyInfo) = this prefix + the 32 raw bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class SignatureError extends Error {
  override readonly name = 'SignatureError';
}

function lines(base64Text: string): string[] {
  return Buffer.from(base64Text.trim(), 'base64')
    .toString('utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

interface PublicKey {
  keyId: Buffer;
  key: ReturnType<typeof createPublicKey>;
}

export function parsePublicKey(base64Text: string): PublicKey {
  const blob = lines(base64Text).find((l) => !l.startsWith('untrusted comment:'));
  const raw = blob ? Buffer.from(blob, 'base64') : Buffer.alloc(0);
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new SignatureError('The update public key is not valid.');
  }
  return {
    keyId: raw.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10)]),
      format: 'der',
      type: 'spki',
    }),
  };
}

/** Throws a SignatureError unless `signature` is the update key's signature of `data`. */
export function verifySignature(publicKey: string, signature: string, data: Buffer): void {
  verifyWith(publicKey, signature, (algorithm) =>
    algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data,
  );
}

/** The same for a file (an installer), read in pieces: only the prehashed form ("ED"). */
export async function verifyFileSignature(
  publicKey: string,
  signature: string,
  path: string,
): Promise<void> {
  const hash = createHash('blake2b512');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const digest = hash.digest();
  verifyWith(publicKey, signature, (algorithm) => {
    if (algorithm !== 'ED') throw new SignatureError('The update signature is not valid.');
    return digest;
  });
}

function verifyWith(
  publicKey: string,
  signature: string,
  messageFor: (algorithm: 'ED' | 'Ed') => Buffer,
): void {
  const key = parsePublicKey(publicKey);
  const text = lines(signature);
  const sigLine = text.find((l) => !l.includes('comment:'));
  const trusted = text.find((l) => l.startsWith('trusted comment: '));
  const globalLine = trusted ? text[text.indexOf(trusted) + 1] : undefined;
  const sig = sigLine ? Buffer.from(sigLine, 'base64') : Buffer.alloc(0);
  if (sig.length !== 74 || !trusted || !globalLine) {
    throw new SignatureError('The update signature is not valid.');
  }
  const algorithm = sig.subarray(0, 2).toString('latin1');
  if (!sig.subarray(2, 10).equals(key.keyId)) {
    throw new SignatureError('The update was signed with another key.');
  }
  // "ED": the file's BLAKE2b-512 is signed (Tauri's signer); "Ed": the file itself.
  if (algorithm !== 'ED' && algorithm !== 'Ed') {
    throw new SignatureError('The update signature is not valid.');
  }
  const message = messageFor(algorithm);
  const signatureBytes = sig.subarray(10);
  if (!verify(null, message, key.key, signatureBytes)) {
    throw new SignatureError('The update signature does not match the file.');
  }
  const comment = Buffer.from(trusted.slice('trusted comment: '.length), 'utf8');
  const global = Buffer.from(globalLine, 'base64');
  if (!verify(null, Buffer.concat([signatureBytes, comment]), key.key, global)) {
    throw new SignatureError("The update signature's trusted comment was changed.");
  }
}
