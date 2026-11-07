/**
 * The server's own speed (M7, decision 0119; PRD §12): how long item searches, barcode scans and
 * POS sales take, measured on the server for every request. Only the last 1,000 durations of each
 * kind are kept, in memory: no content, nothing written to disk. System health shows the 95th
 * percentile against the targets (search and scan under 300 ms, a sale under 2 s).
 */
import type { FastifyInstance } from 'fastify';
import type { SpeedFigures, SpeedKind } from '@artepool/shared/contracts';

export const SPEED_TARGET_MS: Record<SpeedKind, number> = { search: 300, scan: 300, sale: 2000 };
const KEEP = 1000;

const kept: Record<SpeedKind, number[]> = { search: [], scan: [], sale: [] };

/** A barcode is digits only (EAN/UPC 8–14) — the POS sends the scan as the search text. */
const isBarcode = (q: string) => /^\d{8,14}$/.test(q);

export function recordSpeed(kind: SpeedKind, ms: number): void {
  const list = kept[kind];
  list.push(ms);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
}

/** The 95th percentile (nearest rank) of what is kept, or null when nothing was measured yet. */
export function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
}

export function speedFigures(): SpeedFigures {
  const one = (kind: SpeedKind) => {
    const p95 = percentile95(kept[kind]);
    return {
      p95Ms: p95 === null ? null : Math.round(p95),
      samples: kept[kind].length,
      targetMs: SPEED_TARGET_MS[kind],
      slow: p95 !== null && p95 > SPEED_TARGET_MS[kind],
    };
  };
  return { search: one('search'), scan: one('scan'), sale: one('sale') };
}

/** Forgets what was measured (tests, and a rehearsal measuring its own run). */
export function resetSpeed(): void {
  for (const kind of Object.keys(kept) as SpeedKind[]) kept[kind].length = 0;
}

/** Times the searches, scans and sales that end well (a refused request says nothing of speed). */
export function registerSpeed(app: FastifyInstance): void {
  app.addHook('onResponse', (request, reply, done) => {
    if (reply.statusCode < 400) {
      const route = request.routeOptions.url;
      if (request.method === 'POST' && route === '/api/v1/pos/sales') {
        recordSpeed('sale', reply.elapsedTime);
      } else if (request.method === 'GET' && route === '/api/v1/items') {
        const q = (request.query as { q?: unknown } | undefined)?.q;
        if (typeof q === 'string' && q.trim() !== '')
          recordSpeed(isBarcode(q.trim()) ? 'scan' : 'search', reply.elapsedTime);
      }
    }
    done();
  });
}
