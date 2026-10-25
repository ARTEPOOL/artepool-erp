/**
 * The off-site copy's contents (decision 0102): the database copy and the server's master key,
 * together, encrypted for the owner's backup key with age. Only the owner's offline private key
 * opens it, so a restore on a new server PC keeps passwords, phone 2-step and every other sealed
 * value working. Inside the encryption:
 *
 *   ARTEPOOL-BUNDLE 1\n
 *   {"version":1,"dump":"artepool-….dump","dumpBytes":…,"dumpSha256":"…","masterKey":"…"}\n
 *   <the pg_dump file, byte for byte>
 *
 * Older off-site copies (before this format) hold the database copy only; they still open, with
 * no master key: after restoring one, the 2-step codes are set up again (decision 0029).
 */
import { createHash } from 'node:crypto';
import { Decrypter, Encrypter } from 'age-encryption';

const MAGIC = 'ARTEPOOL-BUNDLE 1\n';
const AGE_MAGIC = 'age-encryption.org/v1';
/** pg_dump's custom format starts with these bytes. */
const PGDUMP_MAGIC = 'PGDMP';
const MAX_HEADER = 4096;

export class BundleError extends Error {
  override readonly name = 'BundleError';
  constructor(
    readonly reason: 'wrong_key' | 'not_a_copy' | 'damaged',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface BundleHeader {
  version: 1;
  dump: string;
  dumpBytes: number;
  dumpSha256: string;
  masterKey: string;
}

export interface OpenedCopy {
  /** The pg_dump file. */
  dump: Buffer;
  /** The master key of the server that made the copy; null for a copy without one. */
  masterKey: Buffer | null;
  /** The name of the database copy inside, when known. */
  dumpName: string | null;
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The bundle, encrypted for the owner's backup key (an age X25519 recipient). */
export async function encryptBundle(
  dump: Buffer,
  dumpName: string,
  masterKey: Buffer,
  recipient: string,
): Promise<Buffer> {
  if (masterKey.length !== 32) throw new Error('The master key must be 32 bytes.');
  const header: BundleHeader = {
    version: 1,
    dump: dumpName,
    dumpBytes: dump.length,
    dumpSha256: sha256(dump),
    masterKey: masterKey.toString('base64'),
  };
  const plain = Buffer.concat([
    Buffer.from(MAGIC, 'utf8'),
    Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'),
    dump,
  ]);
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return Buffer.from(await encrypter.encrypt(plain));
}

/** Reads a decrypted bundle, or a plain database copy (an older off-site copy, a local copy). */
export function readCopy(plain: Buffer): OpenedCopy {
  if (plain.subarray(0, PGDUMP_MAGIC.length).toString('latin1') === PGDUMP_MAGIC) {
    return { dump: plain, masterKey: null, dumpName: null };
  }
  if (plain.subarray(0, MAGIC.length).toString('utf8') !== MAGIC) {
    throw new BundleError('not_a_copy', 'This file is not an ARTEPOOL backup copy.');
  }
  const end = plain.indexOf(0x0a, MAGIC.length);
  if (end < 0 || end - MAGIC.length > MAX_HEADER) {
    throw new BundleError('damaged', 'The backup copy is damaged (no header).');
  }
  let header: BundleHeader;
  try {
    header = JSON.parse(plain.subarray(MAGIC.length, end).toString('utf8')) as BundleHeader;
  } catch (error) {
    throw new BundleError('damaged', 'The backup copy is damaged (header).', { cause: error });
  }
  const dump = plain.subarray(end + 1);
  const masterKey = Buffer.from(header.masterKey ?? '', 'base64');
  if (
    header.version !== 1 ||
    dump.length !== header.dumpBytes ||
    sha256(dump) !== header.dumpSha256 ||
    masterKey.length !== 32 ||
    dump.subarray(0, PGDUMP_MAGIC.length).toString('latin1') !== PGDUMP_MAGIC
  ) {
    throw new BundleError('damaged', 'The backup copy is damaged (its contents do not match).');
  }
  return { dump: Buffer.from(dump), masterKey, dumpName: header.dump };
}

/**
 * Opens a copy: an age-encrypted one with the owner's private key (`AGE-SECRET-KEY-1…`), or a
 * plain database copy as it is (the external drive's copies are not encrypted, decision 0086).
 */
export async function openCopy(file: Buffer, privateKey: string | null): Promise<OpenedCopy> {
  if (file.subarray(0, AGE_MAGIC.length).toString('latin1') !== AGE_MAGIC) return readCopy(file);
  if (!privateKey)
    throw new BundleError('wrong_key', 'This copy is encrypted: the private key is needed.');
  let plain: Uint8Array;
  try {
    const decrypter = new Decrypter();
    decrypter.addIdentity(privateKey.trim());
    plain = await decrypter.decrypt(new Uint8Array(file));
  } catch (error) {
    throw new BundleError('wrong_key', 'This key does not open this copy.', { cause: error });
  }
  return readCopy(Buffer.from(plain));
}
