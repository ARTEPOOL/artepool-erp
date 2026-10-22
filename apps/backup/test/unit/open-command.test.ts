/**
 * `pnpm backup:open` (emergency manual restore, decision 0102): an encrypted off-site copy opened
 * with the owner's private key gives the database copy; a wrong key is refused and nothing is
 * written; an existing output file is never overwritten.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptBundle } from '../../src/bundle';

const cli = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
let dir: string;
const dump = Buffer.concat([Buffer.from('PGDMP'), randomBytes(2000)]);

function open(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', cli, 'open', ...args],
      { env: { PATH: process.env.PATH } },
      (error, stdout, stderr) =>
        resolve({ code: error ? Number(error.code ?? 1) : 0, out: `${stdout}${stderr}` }),
    );
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artepool-open-'));
  const identity = await generateX25519Identity();
  await writeFile(join(dir, 'key.txt'), `${identity}\n`);
  await writeFile(join(dir, 'other.txt'), `${await generateX25519Identity()}\n`);
  await writeFile(
    join(dir, 'copy.dump.age'),
    await encryptBundle(dump, 'x.dump', randomBytes(32), await identityToRecipient(identity)),
  );
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('backup:open', () => {
  it('writes the database copy from an encrypted copy, with the right key only', async () => {
    const wrong = await open(
      join(dir, 'copy.dump.age'),
      join(dir, 'other.txt'),
      join(dir, 'w.dump'),
    );
    expect(wrong.code).not.toBe(0);
    expect(wrong.out).toContain('This key does not open this copy');
    expect(existsSync(join(dir, 'w.dump'))).toBe(false);

    const right = await open(join(dir, 'copy.dump.age'), join(dir, 'key.txt'), join(dir, 'a.dump'));
    expect(right.out).toContain('Database copy written');
    expect(right.code).toBe(0);
    expect((await readFile(join(dir, 'a.dump'))).equals(dump)).toBe(true);

    const again = await open(join(dir, 'copy.dump.age'), join(dir, 'key.txt'), join(dir, 'a.dump'));
    expect(again.code).not.toBe(0);
    expect(again.out).toContain('EEXIST');
  }, 60_000);
});
