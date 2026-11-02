/**
 * The steps of an update (decision 0115, 0.9.0): prepare → stop → backup → database → start, each
 * with its start and end time; a failure marks its step and keeps the reason; the file is written
 * whole (a reader never sees half of it) and anything that is not a steps file is ignored.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beginProgress,
  finishProgress,
  readProgress,
  startStep,
  stepOfFailure,
  UPDATE_STEPS,
  writeProgress,
} from '../../src/cli/upgrade/progress';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 5, 23, minute));
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artepool-progress-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('the steps of an update (0115)', () => {
  it('begin with "prepare", since the setup started', () => {
    const p = beginProgress('0.9.0', '0.9.1', at(5), at(3));
    expect(p.startedAt).toBe(at(3).toISOString());
    expect(p.steps.map((s) => [s.step, s.state])).toEqual([
      ['prepare', 'running'],
      ['stop', 'pending'],
      ['backup', 'pending'],
      ['database', 'pending'],
      ['start', 'pending'],
    ]);
    // A start time in the future (a wrong clock) is not believed.
    expect(beginProgress('0.9.0', '0.9.1', at(5), at(9)).startedAt).toBe(at(5).toISOString());
  });

  it('end each step when the next begins, with its times', () => {
    let p = beginProgress('0.9.0', '0.9.1', at(0));
    p = startStep(p, 'stop', at(1));
    p = startStep(p, 'backup', at(2));
    expect(p.steps.slice(0, 3)).toEqual([
      {
        step: 'prepare',
        state: 'done',
        startedAt: at(0).toISOString(),
        endedAt: at(1).toISOString(),
      },
      { step: 'stop', state: 'done', startedAt: at(1).toISOString(), endedAt: at(2).toISOString() },
      { step: 'backup', state: 'running', startedAt: at(2).toISOString(), endedAt: null },
    ]);
    p = finishProgress(startStep(startStep(p, 'database', at(3)), 'start', at(4)), at(5), {
      ok: true,
    });
    expect(p.steps.every((s) => s.state === 'done' && s.endedAt !== null)).toBe(true);
    expect(p.result).toEqual({ ok: true, at: at(5).toISOString(), step: null, detail: null });
  });

  it('a failure marks its step and keeps the reason; the later steps never ran', () => {
    let p = startStep(
      startStep(beginProgress('0.9.0', '0.9.1', at(0)), 'stop', at(1)),
      'backup',
      at(2),
    );
    p = startStep(p, 'database', at(3));
    p = finishProgress(p, at(4), { ok: false, step: 'database', detail: 'relation exists' });
    expect(p.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'failed', 'pending']);
    expect(p.steps[4]).toMatchObject({ startedAt: null, endedAt: null });
    expect(p.result).toEqual({
      ok: false,
      at: at(4).toISOString(),
      step: 'database',
      detail: 'relation exists',
    });
  });

  it("places the upgrade program's own failure steps among the five", () => {
    expect(stepOfFailure('checks')).toBe('prepare');
    expect(stepOfFailure('test_version')).toBe('prepare');
    expect(stepOfFailure('open_shift')).toBe('stop');
    expect(stepOfFailure('backup')).toBe('backup');
    expect(stepOfFailure('services')).toBe('database');
    expect(stepOfFailure('migrate')).toBe('database');
    expect(stepOfFailure('health')).toBe('start');
    expect(stepOfFailure('put_back')).toBe('start');
    expect(UPDATE_STEPS).toHaveLength(5);
  });

  it('is written whole and read back; anything else is no steps file', async () => {
    const file = join(dir, 'progress.json');
    const p = startStep(beginProgress('0.9.0', '0.9.1', at(0)), 'stop', at(1));
    await writeProgress(file, p);
    expect(await readProgress(file)).toEqual(p);
    await writeFile(file, '{"from":"0.9.0"}');
    expect(await readProgress(file)).toBeNull();
    expect(await readProgress(join(dir, 'none.json'))).toBeNull();
  });
});
