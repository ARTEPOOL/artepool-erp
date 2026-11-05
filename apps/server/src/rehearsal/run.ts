/**
 * One rehearsal from start to end (M7, decision 0119): its own database → the scripted day
 * through the real API → every integrity check of part A → a backup of the rehearsal database,
 * restored into a throwaway copy and checked again → the speed figures → the database dropped.
 * The live database is never touched here: the caller records the progress and the result.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  allOk,
  configFromEnv,
  localBackup,
  restoreTest,
  runChecks,
  type CheckResults,
} from '@artepool/backup';
import type { SpeedFigures } from '@artepool/shared/contracts';
import { connectionFor } from '@artepool/node-kit';
import { resetSpeed, speedFigures } from '../platform/http/speed';
import { createRehearsalDatabase, dropRehearsalDatabase } from './database';
import { RehearsalServer } from './harness';
import { runScriptedDay, type RehearsalSize, type StepOutcome } from './script';

export const RUN_STEPS = [
  'database',
  'server',
  'day',
  'checks',
  'backup_restore',
  'speed',
] as const;

export interface RehearsalTotals {
  posSales: number;
  posReturns: number;
  a4Documents: number;
  payments: number;
  shifts: number;
  approvals: number;
  labelPrints: number;
  journalEntries: number;
  auditEntries: number;
}

export interface RehearsalReport {
  size: RehearsalSize['name'];
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  /** Every step: the run's own (database, checks, …) and the scripted day's, in order. */
  steps: StepOutcome[];
  /** The integrity checks on the rehearsal database at the end of the day. */
  checks: CheckResults | null;
  /** The same checks on the copy restored from the rehearsal's backup. */
  restoredChecks: CheckResults | null;
  speed: SpeedFigures | null;
  totals: RehearsalTotals | null;
}

export interface RunHooks {
  /** Hears each step as it ends (the shop's screen shows the progress from it). */
  progress?: (outcome: StepOutcome, report: RehearsalReport) => void | Promise<void>;
}

/** Speed figures within the targets (PRD §12): search and scan 300 ms, a sale 2 s (95%). */
export const speedOk = (speed: SpeedFigures): boolean =>
  !speed.search.slow && !speed.scan.slow && !speed.sale.slow;

async function totalsOf(databaseName: string): Promise<RehearsalTotals> {
  const client = new pg.Client({ ...connectionFor('backup', databaseName) });
  await client.connect();
  try {
    const { rows } = await client.query<Record<keyof RehearsalTotals, string>>(
      `SELECT (SELECT count(*) FROM sales.documents
                WHERE channel = 'pos' AND doc_type = 'invoice' AND status = 'issued')::text AS "posSales",
              (SELECT count(*) FROM sales.documents
                WHERE channel = 'pos' AND doc_type = 'credit_note' AND status = 'issued')::text AS "posReturns",
              (SELECT count(*) FROM sales.documents
                WHERE channel = 'office' AND status = 'issued')::text AS "a4Documents",
              (SELECT count(*) FROM sales.payments)::text AS payments,
              (SELECT count(*) FROM cash.shifts)::text AS shifts,
              (SELECT count(*) FROM auth.approvals)::text AS approvals,
              (SELECT count(*) FROM inv.label_prints)::text AS "labelPrints",
              (SELECT count(*) FROM gl.journal_entries)::text AS "journalEntries",
              (SELECT count(*) FROM audit.log)::text AS "auditEntries"`,
    );
    const r = rows[0]!;
    return Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, Number(v)]),
    ) as unknown as RehearsalTotals;
  } finally {
    await client.end();
  }
}

/** Runs one rehearsal of `size`. Never throws: a failure is a red step in the report. */
export async function runRehearsal(
  size: RehearsalSize,
  hooks: RunHooks = {},
): Promise<RehearsalReport> {
  const report: RehearsalReport = {
    size: size.name,
    ok: false,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    steps: [],
    checks: null,
    restoredChecks: null,
    speed: null,
    totals: null,
  };
  const record = async (outcome: StepOutcome) => {
    report.steps.push(outcome);
    await hooks.progress?.(outcome, report);
  };
  const step = async <T>(name: (typeof RUN_STEPS)[number], work: () => Promise<T>) => {
    const started = Date.now();
    try {
      const value = await work();
      await record({ step: name, ok: true, ms: Date.now() - started });
      return value;
    } catch (error) {
      await record({
        step: name,
        ok: false,
        ms: Date.now() - started,
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
      throw new Stop();
    }
  };

  let database: { name: string; token: string } | null = null;
  let server: RehearsalServer | null = null;
  let backupDir: string | null = null;
  try {
    database = await step('database', createRehearsalDatabase);
    const db = database;
    server = await step('server', () => RehearsalServer.start(db.name));
    resetSpeed();
    const day = await runScriptedDay(server, size, (outcome) => record(outcome));
    const dayOk = day.every((s) => s.ok);
    await step('day', () => {
      if (!dayOk) throw new Error('The scripted day stopped at a red step');
      return Promise.resolve();
    });
    const speed = speedFigures();
    await server.close();
    server = null;

    report.totals = await totalsOf(db.name);
    report.checks = await step('checks', async () => {
      const client = new pg.Client({ ...connectionFor('backup', db.name) });
      await client.connect();
      try {
        const results = await runChecks(client);
        report.checks = results;
        if (!allOk(results)) throw new Error(`Checks with problems: ${failedChecks(results)}`);
        return results;
      } finally {
        await client.end();
      }
    });
    await step('backup_restore', async () => {
      backupDir = await mkdtemp(join(tmpdir(), 'artepool-rehearsal-'));
      const config = { ...configFromEnv(db.name), backupDir };
      const client = new pg.Client({ ...config.connection });
      await client.connect();
      try {
        await localBackup(client, config);
        const restored = await restoreTest(client, config);
        report.restoredChecks = restored.results;
        if (!restored.ok) throw new Error(`Restored copy: ${failedChecks(restored.results)}`);
      } finally {
        await client.end();
      }
    });
    report.speed = speed;
    await step('speed', () => {
      if (!speedOk(speed)) throw new Error('Slower than the targets');
      return Promise.resolve();
    });
    report.ok = report.steps.every((s) => s.ok);
  } catch (error) {
    if (!(error instanceof Stop)) {
      await record({
        step: 'unexpected',
        ok: false,
        ms: 0,
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
  } finally {
    await server?.close().catch(() => undefined);
    if (database) await dropRehearsalDatabase(database.name, database.token).catch(() => undefined);
    if (backupDir) await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    report.finishedAt = new Date().toISOString();
  }
  return report;
}

const failedChecks = (results: CheckResults) =>
  Object.entries(results)
    .filter(([, r]) => !r.ok)
    .map(([name, r]) => `${name} (${r.problems})`)
    .join(', ');

class Stop extends Error {}
