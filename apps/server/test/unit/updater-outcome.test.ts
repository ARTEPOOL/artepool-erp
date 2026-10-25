/**
 * The updater's log (decision 0108): the scheduled task runs every five minutes, so a line is
 * written only when the outcome changes, not the same "no key" or "offline" again and again.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outcomeChanged } from '../../src/cli/updater/steps';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artepool-updater-outcome-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('the updater log', () => {
  it('says each outcome once, and again only after a different one', async () => {
    expect(await outcomeChanged(dir, 'no_key')).toBe(true);
    expect(await outcomeChanged(dir, 'no_key')).toBe(false);
    expect(await outcomeChanged(dir, 'no_key')).toBe(false);
    expect(await outcomeChanged(dir, 'offline')).toBe(true);
    expect(await outcomeChanged(dir, 'offline')).toBe(false);
    expect(await outcomeChanged(dir, 'failed: boom')).toBe(true);
    expect(await outcomeChanged(dir, 'offline')).toBe(true);
    expect((await readFile(join(dir, 'last-outcome.txt'), 'utf8')).trim()).toBe('offline');
  });
});
