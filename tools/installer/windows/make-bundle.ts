// CI (M6.2 part F): the shop's off-site copy, as the backup service makes it, from a local copy
// and the installation's master key, encrypted for a new backup key. Writes <out>\copy.dump.age
// and <out>\key.txt. Usage: tsx make-bundle.ts <copy.dump> <master key base64> <out folder>
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { encryptBundle } from '../../../apps/backup/src/bundle';

const [dump, masterKey, out] = process.argv.slice(2);
if (!dump || !masterKey || !out)
  throw new Error('Usage: make-bundle <copy.dump> <master key> <out>');
const identity = await generateX25519Identity();
const sealed = await encryptBundle(
  await readFile(dump),
  basename(dump),
  Buffer.from(masterKey, 'base64'),
  await identityToRecipient(identity),
);
await writeFile(join(out, 'copy.dump.age'), sealed);
await writeFile(join(out, 'key.txt'), `# CI backup key\n${identity}\n`);
console.log(`ok - encrypted copy of ${basename(dump)} written to ${out}`);
