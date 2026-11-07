/**
 * The rehearsal started from System health (M7 part B, decision 0119), on the shop's server PC:
 * - the updater takes the owner's request (claimRehearsal) and starts `artepool-svc run rehearsal`;
 * - the rehearsal program plays the shop's day (runShopRehearsal) and writes each step, a
 *   heartbeat and the result to the run's row in the live database: the only thing it writes
 *   there (as the backup role, the SYSTEM user in the audit log).
 */
import type pg from 'pg';
import { inSystemTx } from '@artepool/backup';
import type { RehearsalResult } from '@artepool/shared/contracts';
import { dropLeftoverRehearsals } from './database';
import { runRehearsal, type RehearsalReport } from './run';
import { SHOP_DAY, type RehearsalSize, type StepOutcome } from './script';

/** A run whose program has not written its heartbeat for this long was cut off. */
export const HEARTBEAT_EVERY_MS = 30_000;
export const STALE_AFTER = '5 minutes';

export type Claim =
  | { kind: 'start'; id: string }
  | { kind: 'refused'; id: string; reason: 'shift_open' }
  | { kind: 'none' };

/**
 * The updater's part (every minute and when woken): a run cut off half way (a power cut) is
 * marked red; a waiting request is taken, unless a shift was opened since it was asked for
 * (refused: red, with the reason). The caller starts the program for a 'start'.
 */
export async function claimRehearsal(client: pg.Client): Promise<Claim> {
  return inSystemTx(client, 'automated rehearsal (0119)', async () => {
    await client.query(
      `UPDATE ops.rehearsal_runs
          SET status = 'failed', finished_at = now(),
              failure = 'The rehearsal stopped half way (the server PC restarted or the program was closed).'
        WHERE status = 'running' AND coalesce(heartbeat_at, started_at) < now() - $1::interval`,
      [STALE_AFTER],
    );
    const { rows } = await client.query<{ id: string; shift: boolean }>(
      `SELECT r.id::text, EXISTS (SELECT 1 FROM cash.shifts WHERE status = 'open') AS shift
         FROM ops.rehearsal_runs r WHERE r.status = 'requested' FOR UPDATE`,
    );
    const run = rows[0];
    if (!run) return { kind: 'none' };
    if (run.shift) {
      await client.query(
        `UPDATE ops.rehearsal_runs SET status = 'failed', finished_at = now(),
                failure = 'A shift was opened before the rehearsal started: close it and start again.'
          WHERE id = $1`,
        [run.id],
      );
      return { kind: 'refused', id: run.id, reason: 'shift_open' };
    }
    await client.query(
      `UPDATE ops.rehearsal_runs SET status = 'running', started_at = now(), heartbeat_at = now()
        WHERE id = $1`,
      [run.id],
    );
    return { kind: 'start', id: run.id };
  });
}

/** What is kept of the report with the run (the steps are kept on their own). */
export function resultOf(report: RehearsalReport): RehearsalResult {
  return {
    checks: report.checks,
    restoredChecks: report.restoredChecks,
    speed: report.speed,
    totals: report.totals as Record<string, number> | null,
    reconciliation: report.reconciliation
      ? (({ id: _id, ...rest }) => rest)(report.reconciliation)
      : null,
  };
}

/** The program's part: plays the day for run `id` and writes its progress and result. */
export async function runShopRehearsal(
  live: pg.Client,
  id: string,
  options: { size?: RehearsalSize; heartbeatMs?: number; workDir?: string } = {},
): Promise<RehearsalReport> {
  const { rows } = await live.query<{ status: string }>(
    'SELECT status FROM ops.rehearsal_runs WHERE id = $1',
    [id],
  );
  if (rows[0]?.status !== 'running') throw new Error(`Rehearsal ${id} is not running`);
  const write = (sql: string, params: unknown[]) =>
    inSystemTx(live, 'automated rehearsal (0119)', () => live.query(sql, params));
  // One write at a time on the one connection: progress, heartbeat and the result queue up.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (sql: string, params: unknown[]) => {
    queue = queue.then(() => write(sql, params)).catch(() => undefined);
    return queue;
  };
  const beat = setInterval(
    () => void enqueue('UPDATE ops.rehearsal_runs SET heartbeat_at = now() WHERE id = $1', [id]),
    options.heartbeatMs ?? HEARTBEAT_EVERY_MS,
  );
  try {
    // A rehearsal database left by a run that was cut off goes first.
    await dropLeftoverRehearsals();
    const steps: StepOutcome[] = [];
    const report = await runRehearsal(options.size ?? SHOP_DAY, {
      ...(options.workDir ? { workDir: options.workDir } : {}),
      progress: async (outcome) => {
        steps.push(outcome);
        await enqueue(
          'UPDATE ops.rehearsal_runs SET steps = $2::jsonb, heartbeat_at = now() WHERE id = $1',
          [id, JSON.stringify(steps)],
        );
      },
    });
    clearInterval(beat);
    await queue;
    await write(
      `UPDATE ops.rehearsal_runs
          SET status = $2, finished_at = now(), steps = $3::jsonb, report = $4::jsonb, failure = $5
        WHERE id = $1`,
      [
        id,
        report.ok ? 'passed' : 'failed',
        JSON.stringify(report.steps),
        JSON.stringify(resultOf(report)),
        report.ok ? null : (report.steps.find((s) => !s.ok)?.detail ?? 'A step failed'),
      ],
    );
    return report;
  } catch (error) {
    clearInterval(beat);
    await queue;
    await write(
      `UPDATE ops.rehearsal_runs SET status = 'failed', finished_at = now(), failure = $2
        WHERE id = $1 AND status = 'running'`,
      [id, (error instanceof Error ? error.message : String(error)).slice(0, 2000)],
    ).catch(() => undefined);
    throw error;
  }
}
