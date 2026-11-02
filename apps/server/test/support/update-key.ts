/**
 * A throwaway update key for the tests (decisions 0108, 0115): it signs any file exactly as
 * Tauri's signer does (minisign, the file's BLAKE2b-512 signed: "ED"), so a test can publish
 * several signed files (an update package, a runtime package) and check the updater accepts only
 * those. Its private half lives only in the test's memory.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const b64 = (text: string) => Buffer.from(text).toString('base64');

export interface TestUpdateKey {
  /** As Tauri gives it: base64 of the minisign public key text. */
  publicKey: string;
  /** As `tauri signer sign` gives it: base64 of the minisign signature text. */
  signFile(data: Buffer, name: string): string;
}

export function testUpdateKey(): TestUpdateKey {
  const pair = generateKeyPairSync('ed25519');
  const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const keyId = randomBytes(8);
  const publicKey = b64(
    `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`,
  );
  return {
    publicKey,
    signFile(data, name) {
      const digest = createHash('blake2b512').update(data).digest();
      const signature = sign(null, digest, pair.privateKey);
      const blob = Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64');
      const comment = `timestamp:1762070400\tfile:${name}`;
      const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), pair.privateKey);
      return b64(
        `untrusted comment: signature from tauri secret key\n${blob}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`,
      );
    },
  };
}

/** A zip file with these (empty, stored) entries: enough for the checks of its names. */
export function zipWith(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const bytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(bytes.length, 26);
    locals.push(local, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(bytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, bytes);
    offset += 30 + bytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The names of a runtime package (decision 0115). */
export const RUNTIME_ZIP_NAMES = [
  'runtime.json',
  'node/',
  'node/node.exe',
  'pgsql/',
  'pgsql/bin/',
  'pgsql/bin/pg_ctl.exe',
  'pgsql/bin/postgres.exe',
  'winsw/',
  'winsw/winsw.exe',
];
