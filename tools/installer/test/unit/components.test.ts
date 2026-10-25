/**
 * The installer's pinned programs (M6.2 part F): every component has an https address and a
 * SHA-256; a download is kept only when its hash matches, and a wrong one is deleted.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchComponent, HashMismatchError, readComponents } from '../../src/components';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artepool-components-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const content = Buffer.from('MZ pretend program');
const sha = createHash('sha256').update(content).digest('hex');

describe('pinned components', () => {
  it('the real list: Node 24, PostgreSQL 18, WinSW, each with https and a SHA-256', async () => {
    const components = await readComponents();
    expect(components.node.version).toMatch(/^24\./);
    expect(components.postgresql.version).toMatch(/^18\./);
    for (const c of Object.values(components)) {
      expect(c.url.startsWith('https://')).toBe(true);
      expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('keeps a download only when its hash matches; a wrong one is deleted', async () => {
    const good = { version: '1', url: 'https://example.invalid/a.exe', sha256: sha, file: 'a.exe' };
    const path = await fetchComponent(good, dir, () => Promise.resolve(Readable.from([content])));
    expect((await readFile(path)).equals(content)).toBe(true);
    // Already there and correct: not downloaded again.
    await fetchComponent(good, dir, () => Promise.reject(new Error('no second download')));

    const bad = { ...good, file: 'b.exe' };
    await expect(
      fetchComponent(bad, dir, () => Promise.resolve(Readable.from([Buffer.from('tampered')]))),
    ).rejects.toThrow(HashMismatchError);
    expect(existsSync(join(dir, 'b.exe'))).toBe(false);
    expect(existsSync(join(dir, 'b.exe.partial'))).toBe(false);

    // A file changed after download is replaced by a fresh, checked one.
    await writeFile(path, 'changed');
    await fetchComponent(good, dir, () => Promise.resolve(Readable.from([content])));
    expect((await readFile(path)).equals(content)).toBe(true);
  });

  it('refuses a list without a hash or with a plain http address', async () => {
    const file = join(dir, 'bad.json');
    await writeFile(
      file,
      JSON.stringify({ node: { url: 'http://x', sha256: 'x', file: 'n', version: '1' } }),
    );
    await expect(readComponents(file)).rejects.toThrow(/https url/);
  });
});
