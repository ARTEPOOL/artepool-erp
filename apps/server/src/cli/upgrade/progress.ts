/**
 * The steps of an update (decision 0115, 0.9.0), in `updates\progress.json` while it runs:
 *
 *   prepare    the new programs unpacked beside the installed ones (the setup), the checks
 *   stop       the server and backup services stopped; no shift may be open
 *   backup     the checked pre-upgrade copy; the database stopped for the folder swap
 *   database   the new version's services; the database changes, all or nothing
 *   start      the server and backup services started; the server answers
 *
 * `upgrade prepare` and `upgrade apply` write it at each step (a new file each time, renamed into
 * place, so a reader never sees half of it). The status page reads it while the server is
 * stopped; the result keeps the steps with their times for System health. It holds the versions,
 * the step names, their times and the failure's reason: never any business data.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';

export const UPDATE_STEPS = ['prepare', 'stop', 'backup', 'database', 'start'] as const;
export type UpdateStepName = (typeof UPDATE_STEPS)[number];

const stepRecord = z.object({
  step: z.enum(UPDATE_STEPS),
  state: z.enum(['pending', 'running', 'done', 'failed']),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type StepRecord = z.infer<typeof stepRecord>;

export const progressSchema = z.object({
  from: z.string().max(20),
  to: z.string().max(20),
  startedAt: z.string(),
  steps: z.array(stepRecord).length(UPDATE_STEPS.length),
  result: z
    .object({
      ok: z.boolean(),
      at: z.string(),
      step: z.enum(UPDATE_STEPS).nullable(),
      detail: z.string().max(700).nullable(),
    })
    .nullable(),
});
export type UpdateProgress = z.infer<typeof progressSchema>;

/**
 * Where a failure of the upgrade program (its own step names) shows among the steps: the checks
 * belong to "prepare", an open shift to "stop", and so on.
 */
export function stepOfFailure(step: string): UpdateStepName {
  switch (step) {
    case 'open_shift':
      return 'stop';
    case 'backup':
      return 'backup';
    case 'services':
    case 'migrate':
      return 'database';
    case 'health':
    case 'put_back':
      return 'start';
    default:
      return 'prepare';
  }
}

/** An update that has begun: "prepare" running since the setup started (or now). */
export function beginProgress(from: string, to: string, now: Date, since?: Date): UpdateProgress {
  const started = (since && since.getTime() <= now.getTime() ? since : now).toISOString();
  return {
    from,
    to,
    startedAt: started,
    steps: UPDATE_STEPS.map((step) => ({
      step,
      state: step === 'prepare' ? 'running' : 'pending',
      startedAt: step === 'prepare' ? started : null,
      endedAt: null,
    })),
    result: null,
  };
}

/** `step` begins: every earlier step is done (with this time when it had none). */
export function startStep(
  progress: UpdateProgress,
  step: UpdateStepName,
  now: Date,
): UpdateProgress {
  const at = now.toISOString();
  const index = UPDATE_STEPS.indexOf(step);
  return {
    ...progress,
    steps: progress.steps.map((record, i) => {
      if (i < index) {
        return record.state === 'done' || record.state === 'failed'
          ? record
          : { ...record, state: 'done', startedAt: record.startedAt ?? at, endedAt: at };
      }
      if (i === index) return { ...record, state: 'running', startedAt: at, endedAt: null };
      return record;
    }),
  };
}

/**
 * The update has ended. Done: every step is done. Failed: the step that failed is marked, with
 * the reason; the later steps stay "pending".
 */
export function finishProgress(
  progress: UpdateProgress,
  now: Date,
  outcome: { ok: true } | { ok: false; step: UpdateStepName; detail: string },
): UpdateProgress {
  const at = now.toISOString();
  const failedIndex = outcome.ok ? -1 : UPDATE_STEPS.indexOf(outcome.step);
  return {
    ...progress,
    steps: progress.steps.map((record, i) => {
      if (outcome.ok || i < failedIndex) {
        return record.state === 'done'
          ? record
          : { ...record, state: 'done', startedAt: record.startedAt ?? at, endedAt: at };
      }
      if (i === failedIndex) {
        return { ...record, state: 'failed', startedAt: record.startedAt ?? at, endedAt: at };
      }
      return { ...record, state: 'pending', startedAt: null, endedAt: null };
    }),
    result: outcome.ok
      ? { ok: true, at, step: null, detail: null }
      : { ok: false, at, step: outcome.step, detail: outcome.detail.slice(0, 700) },
  };
}

/** Written beside, then renamed into place: a reader sees the old file or the new, never half. */
export async function writeProgress(file: string, progress: UpdateProgress): Promise<void> {
  const next = `${file}.next`;
  await writeFile(next, `${JSON.stringify(progressSchema.parse(progress), null, 2)}\n`);
  await rename(next, file);
}

/** The steps file, or null when there is none or it is not one. */
export async function readProgress(file: string): Promise<UpdateProgress | null> {
  try {
    return progressSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return null;
  }
}
