/**
 * Downloads continue where they stopped (decision 0115), against a real local HTTP server: a cut
 * in the middle keeps what arrived and the next try asks only for the rest; a server that ignores
 * ranges sends the whole file again and the part is replaced; a file already whole is left alone;
 * the progress counts up to the total.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resumableDownload } from '../../src/cli/updater/download';

const content = randomBytes(256 * 1024);
let server: Server;
let base: string;
let dir: string;
/** How the next request is answered. */
let mode: 'cut' | 'ranges' | 'no-ranges' = 'ranges';
const ranges: (string | undefined)[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artepool-download-'));
  server = createServer((req, res) => {
    const range = req.headers.range;
    ranges.push(range);
    const match = range && mode !== 'no-ranges' ? /^bytes=(\d+)-$/.exec(range) : null;
    const from = match ? Number(match[1]) : 0;
    if (match && from >= content.length) {
      res.writeHead(416, { 'content-range': `bytes */${content.length}` }).end();
      return;
    }
    const body = content.subarray(from);
    res.writeHead(
      match ? 206 : 200,
      match
        ? {
            'content-length': body.length,
            'content-range': `bytes ${from}-${content.length - 1}/${content.length}`,
          }
        : { 'content-length': body.length },
    );
    if (mode === 'cut') {
      // Part of it, then the connection drops (after the client has had time to read it).
      res.write(body.subarray(0, 100 * 1024));
      setTimeout(() => res.socket?.destroy(), 150);
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/setup.exe`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  ranges.length = 0;
  mode = 'ranges';
});

describe('a download that continues where it stopped (0115)', () => {
  it('keeps what arrived before a cut, then asks only for the rest', async () => {
    const to = join(dir, 'cut.partial');
    mode = 'cut';
    await expect(resumableDownload(base, to, { timeoutMs: 10_000 })).rejects.toThrow();
    const kept = (await stat(to)).size;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(content.length);

    mode = 'ranges';
    const seen: [number, number | null][] = [];
    await resumableDownload(base, to, {
      timeoutMs: 10_000,
      onProgress: (received, total) => seen.push([received, total]),
    });
    expect(ranges.at(-1)).toBe(`bytes=${kept}-`);
    expect((await readFile(to)).equals(content)).toBe(true);
    // The progress starts from what was kept and ends at the whole size.
    expect(seen[0]).toEqual([kept, content.length]);
    expect(seen.at(-1)).toEqual([content.length, content.length]);
    expect(seen.every(([r], i) => i === 0 || r >= seen[i - 1]![0])).toBe(true);
  });

  it('starts again from nothing when the server sends the whole file', async () => {
    const to = join(dir, 'whole.partial');
    await writeFile(to, Buffer.from('a part of something else'));
    mode = 'no-ranges';
    await resumableDownload(base, to, { timeoutMs: 10_000 });
    expect((await readFile(to)).equals(content)).toBe(true);
  });

  it('leaves a file that is already whole as it is', async () => {
    const to = join(dir, 'done.partial');
    await writeFile(to, content);
    let last: [number, number | null] | null = null;
    await resumableDownload(base, to, {
      timeoutMs: 10_000,
      onProgress: (received, total) => (last = [received, total]),
    });
    expect(last).toEqual([content.length, content.length]);
    expect((await readFile(to)).equals(content)).toBe(true);
  });

  it('a fresh download reports the total from the start', async () => {
    const to = join(dir, 'fresh.partial');
    const totals = new Set<number | null>();
    await resumableDownload(base, to, {
      timeoutMs: 10_000,
      onProgress: (_received, total) => totals.add(total),
    });
    expect(ranges.at(-1)).toBeUndefined();
    expect([...totals]).toEqual([content.length]);
  });
});
