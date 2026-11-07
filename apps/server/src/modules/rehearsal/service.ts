/**
 * The owner's «ابدأ البروفة» (M7 part B, decision 0119): the runs and their results, and a new
 * request. The server PC's updater takes the request and starts the rehearsal program; this
 * module never runs a rehearsal itself (the API serves the shop while it runs).
 */
import { statfs } from 'node:fs/promises';
import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  RehearsalBlock,
  RehearsalResult,
  RehearsalRun,
  RehearsalsResponse,
  RehearsalStepOutcome,
} from '@artepool/shared/contracts';
import { ruleError } from '../../platform/errors/app-error';
import type { DB } from '../../platform/db/schema.generated';

/** The rehearsal database, its backup and its restored copy need room (decision 0119). */
export const REHEARSAL_MIN_FREE_BYTES = 2 * 1024 ** 3;

type RunRow = {
  id: bigint;
  status: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  steps: unknown;
  report: unknown;
  failure: string | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function view(r: RunRow): RehearsalRun {
  return {
    id: r.id.toString(),
    status: r.status as RehearsalRun['status'],
    requestedAt: r.created_at.toISOString(),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    steps: (r.steps as RehearsalStepOutcome[] | null) ?? [],
    result: (r.report as RehearsalResult | null) ?? null,
    failure: r.failure,
  };
}

/** Free space where the database lives (the data folder on the server PC). */
export async function freeBytes(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Why a rehearsal cannot start now, or null. */
export async function blockedReason(
  db: Kysely<DB>,
  free: number | null,
): Promise<RehearsalBlock | null> {
  const { rows } = await sql<{ shift: boolean; update: boolean; running: boolean }>`
    SELECT EXISTS (SELECT 1 FROM cash.shifts WHERE status = 'open') AS shift,
           (EXISTS (SELECT 1 FROM ops.update_requests WHERE status = 'running')
            OR EXISTS (SELECT 1 FROM ops.update_state WHERE waiting_reason = 'installing')) AS update,
           EXISTS (SELECT 1 FROM ops.rehearsal_runs WHERE status IN ('requested', 'running')) AS running`.execute(
    db,
  );
  const r = rows[0]!;
  if (r.running) return 'running';
  if (r.shift) return 'shift_open';
  if (r.update) return 'update_installing';
  if (free !== null && free < REHEARSAL_MIN_FREE_BYTES) return 'low_disk';
  return null;
}

const columns = [
  'id',
  'status',
  'created_at',
  'started_at',
  'finished_at',
  'steps',
  'report',
  'failure',
] as const;

export async function rehearsals(db: Kysely<DB>, free: number | null): Promise<RehearsalsResponse> {
  const rows = (await db
    .selectFrom('ops.rehearsal_runs')
    .select([...columns])
    .orderBy('id', 'desc')
    .limit(11)
    .execute()) as RunRow[];
  const [latest, ...earlier] = rows;
  return {
    latest: latest ? view(latest) : null,
    history: earlier.map((r) => ({
      id: r.id.toString(),
      status: r.status as RehearsalRun['status'],
      requestedAt: r.created_at.toISOString(),
      finishedAt: iso(r.finished_at),
    })),
    blocked: await blockedReason(db, free),
  };
}

export async function rehearsalById(db: Kysely<DB>, id: bigint): Promise<RehearsalRun | null> {
  const row = (await db
    .selectFrom('ops.rehearsal_runs')
    .select([...columns])
    .where('id', '=', id)
    .executeTakeFirst()) as RunRow | undefined;
  return row ? view(row) : null;
}

/** The owner's request; refused with the reason when it cannot start now. */
export async function requestRehearsal(
  trx: Transaction<DB>,
  free: number | null,
): Promise<RehearsalRun> {
  // One request at a time even when two clicks race: the second waits here, then sees the first.
  await sql`SELECT pg_advisory_xact_lock(hashtext('ops.rehearsal_runs: request'))`.execute(trx);
  const reason = await blockedReason(trx, free);
  if (reason)
    throw ruleError('REHEARSAL_BLOCKED', `The rehearsal cannot start: ${reason}`, { reason });
  const row = (await trx
    .insertInto('ops.rehearsal_runs')
    .values({ size: 'shop' } as never)
    .returning([...columns])
    .executeTakeFirstOrThrow()) as RunRow;
  return view(row);
}
