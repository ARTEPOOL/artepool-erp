/**
 * A download that continues where it stopped (decision 0115). The part already received stays in
 * the `.partial` file; the next try asks only for the rest (an HTTP range) and appends it. When the
 * server sends the whole file instead (no range support), the part is thrown away and the file is
 * written from the start. Whether the result is right is decided afterwards, by its SHA-256 and
 * its signature (updater/steps.ts), never by this file.
 */
import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

export type Progress = (received: number, total: number | null) => void;

/** "bytes 1000-1999/5000" → 5000 (null when the total is "*" or missing). */
function totalOf(contentRange: string | null): number | null {
  const match = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;
  return match ? Number(match[1]) : null;
}

export async function resumableDownload(
  url: string,
  to: string,
  options: {
    timeoutMs: number;
    onProgress?: Progress;
    fetchImpl?: typeof fetch;
  },
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const have = existsSync(to) ? (await stat(to)).size : 0;
  const response = await fetchImpl(url, {
    redirect: 'follow',
    headers: have > 0 ? { range: `bytes=${have}-` } : {},
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  // Asked for the rest of a file that is already whole: nothing more to receive.
  if (response.status === 416 && have > 0) {
    options.onProgress?.(have, have);
    return;
  }
  const resumed = have > 0 && response.status === 206;
  if (!resumed && response.status !== 200) throw new Error(`${url}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`${url}: no content`);
  let received = resumed ? have : 0;
  const length = Number(response.headers.get('content-length') ?? NaN);
  const total = resumed
    ? totalOf(response.headers.get('content-range'))
    : Number.isFinite(length)
      ? length
      : null;
  const file = await open(to, resumed ? 'a' : 'w');
  try {
    options.onProgress?.(received, total);
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      const bytes = chunk as Buffer;
      await file.write(bytes);
      received += bytes.length;
      options.onProgress?.(received, total);
    }
  } finally {
    await file.close();
  }
}
