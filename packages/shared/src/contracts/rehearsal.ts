/**
 * The automated rehearsal (M7, decision 0119): the owner's «ابدأ البروفة» on System health. The
 * server PC plays a whole shop day on its own throwaway database and shows each step, then green
 * or red, with the checks, the speed and the seven-step reconciliation report.
 */
import type { ReconciliationReport } from './reports';
import type { SpeedFigures } from './health';

/** The scripted day's steps, in order. */
export const REHEARSAL_DAY_STEPS = [
  'pcs_and_people',
  'company_and_items',
  'customers',
  'shifts_open',
  'the_day',
  'returns',
  'cash_movements',
  'stock',
  'labels',
  'oversell_review',
  'printing',
  'shifts_close',
] as const;
export type RehearsalDayStep = (typeof REHEARSAL_DAY_STEPS)[number];

/** Every step of a run, in the order they end (the day's steps come after 'server'). */
export const REHEARSAL_STEPS = [
  'database',
  'server',
  ...REHEARSAL_DAY_STEPS,
  'day',
  'checks',
  'backup_restore',
  'reconciliation',
  'speed',
] as const;
export type RehearsalStep = (typeof REHEARSAL_STEPS)[number];

export const REHEARSAL_STATUSES = ['requested', 'running', 'passed', 'failed'] as const;
export type RehearsalStatus = (typeof REHEARSAL_STATUSES)[number];

/** Why «ابدأ البروفة» cannot start now. */
export const REHEARSAL_BLOCKS = ['shift_open', 'update_installing', 'running', 'low_disk'] as const;
export type RehearsalBlock = (typeof REHEARSAL_BLOCKS)[number];

export interface RehearsalStepOutcome {
  step: string;
  ok: boolean;
  ms: number;
  /** A red step's reason, in English (support reads it). */
  detail?: string;
}

export interface RehearsalCheck {
  ok: boolean;
  problems: number;
  examples: string[];
}

/** What a finished run found (kept with the run). */
export interface RehearsalResult {
  checks: Record<string, RehearsalCheck> | null;
  restoredChecks: Record<string, RehearsalCheck> | null;
  speed: SpeedFigures | null;
  totals: Record<string, number> | null;
  reconciliation: Omit<ReconciliationReport, 'id'> | null;
}

export interface RehearsalRun {
  id: string;
  status: RehearsalStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: RehearsalStepOutcome[];
  result: RehearsalResult | null;
  /** Why a run is red when no step says it (it could not start, or it was cut off). */
  failure: string | null;
}

export interface RehearsalsResponse {
  /** The newest run, if any. */
  latest: RehearsalRun | null;
  /** Earlier runs, newest first (at most 10). */
  history: Pick<RehearsalRun, 'id' | 'status' | 'requestedAt' | 'finishedAt'>[];
  /** Why a new run cannot start now (null: it can). */
  blocked: RehearsalBlock | null;
}
