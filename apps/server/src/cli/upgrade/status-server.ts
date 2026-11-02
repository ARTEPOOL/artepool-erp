/**
 * The status page (decision 0115, 0.9.0): while the server is stopped for an update, every PC's app
 * can still ask how far the update has come.
 *
 * - It answers `GET /health` with 503, `{"status":"updating","update":…}`: the versions and the
 *   steps (name, state, start and end time) and, at the end, whether it worked and at which step
 *   it stopped. Nothing else from the steps file: no reason text, no business data, no device,
 *   user or company names.
 * - Every other request is refused (503 "UPDATING"); nothing is ever read from a request.
 * - A limit per address: more than `perMinute` requests in a minute are refused (429).
 * - TLS 1.3 only, with the server's own certificate, so the PCs trust it as they trust the server.
 * - It never connects to the database; it only reads the steps file.
 */
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UpdateProgress } from './progress';

/** How many requests one address may make in a minute (the app asks every few seconds). */
export const STATUS_PAGE_PER_MINUTE = 30;

export type StatusAnswer = 'status' | 'refused' | 'limited';

export interface StatusServerOptions {
  cert: string | Buffer;
  key: string | Buffer;
  readProgress: () => Promise<UpdateProgress | null>;
  perMinute?: number;
  clock?: () => number;
  /** Counted for the update's record. */
  onAnswer?: (answer: StatusAnswer) => void;
}

/** What the status page says: only the versions and the steps. */
export function publicStatus(progress: UpdateProgress | null) {
  return {
    status: 'updating' as const,
    update: progress
      ? {
          from: progress.from,
          to: progress.to,
          startedAt: progress.startedAt,
          steps: progress.steps.map((s) => ({
            step: s.step,
            state: s.state,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
          })),
          result: progress.result
            ? { ok: progress.result.ok, at: progress.result.at, step: progress.result.step }
            : null,
        }
      : null,
  };
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // Nothing is read from a request; the connection is not kept for another one.
    connection: 'close',
    ...extra,
  });
  res.end(text);
}

export function createStatusServer(options: StatusServerOptions): Server {
  const perMinute = options.perMinute ?? STATUS_PAGE_PER_MINUTE;
  const clock = options.clock ?? Date.now;
  const seen = new Map<string, { since: number; count: number }>();

  const limited = (address: string): boolean => {
    const now = clock();
    // Old windows go, so the table never grows without end.
    if (seen.size > 1000) {
      for (const [key, value] of seen) if (now - value.since >= 60_000) seen.delete(key);
    }
    const entry = seen.get(address);
    if (!entry || now - entry.since >= 60_000) {
      seen.set(address, { since: now, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > perMinute;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (limited(req.socket.remoteAddress ?? 'unknown')) {
      options.onAnswer?.('limited');
      send(res, 429, { error: { code: 'TOO_MANY_REQUESTS' } }, { 'retry-after': '60' });
      return;
    }
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      options.onAnswer?.('status');
      send(res, 503, publicStatus(await options.readProgress().catch(() => null)), {
        'retry-after': '5',
      });
      return;
    }
    options.onAnswer?.('refused');
    send(res, 503, { error: { code: 'UPDATING', message: 'ARTEPOOL is being updated.' } });
  };

  const server = createServer(
    {
      cert: options.cert,
      key: options.key,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      requestTimeout: 10_000,
      headersTimeout: 5_000,
      keepAliveTimeout: 1_000,
    },
    (req, res) => void handle(req, res),
  );
  server.maxConnections = 100;
  return server;
}
