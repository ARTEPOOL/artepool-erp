/** Which local copies are kept (decision 0086): the last 48 hours, plus the first of each of 30 days. */
import { describe, expect, it } from 'vitest';
import { backupFileName, filesToRemove, timeOf } from '../../src/retention';

const hour = 3600 * 1000;

describe('local copy names and retention', () => {
  it('names a copy by its UTC time, and reads it back', () => {
    const at = new Date('2026-10-19T07:05:09Z');
    expect(backupFileName(at)).toBe('artepool-20261019-070509Z.dump');
    expect(timeOf('artepool-20261019-070509Z.dump')).toEqual(at);
    expect(timeOf('notes.txt')).toBeNull();
    expect(timeOf('artepool-20261019-070509Z.dump.partial')).toBeNull();
  });

  it('keeps the copies of the last 48 hours and the first copy of each of the last 30 days', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    // One copy every hour for 40 days.
    const names = Array.from({ length: 40 * 24 }, (_, i) =>
      backupFileName(new Date(now.getTime() - i * hour)),
    );
    const removed = new Set(filesToRemove(names, now, { hourly: 48, daily: 30 }));
    const kept = names.filter((n) => !removed.has(n));
    // The newest 48 are all kept.
    expect(names.slice(0, 48).every((n) => kept.includes(n))).toBe(true);
    // Older than 48 hours: only the first copy of each day (midnight; the oldest day is cut at
    // 30 days, so its first copy is the one at that hour).
    const older = kept.filter((n) => !names.slice(0, 49).includes(n));
    expect(older.filter((n) => !n.includes('-000000Z')).length).toBeLessThanOrEqual(1);
    expect(older.length).toBeGreaterThanOrEqual(27);
    expect(older.length).toBeLessThanOrEqual(30);
    // Nothing older than 30 days is left.
    expect(
      kept.every((n) => now.getTime() - timeOf(n)!.getTime() <= 30 * 24 * hour + 48 * hour),
    ).toBe(true);
    // Other files in the folder are never touched.
    expect(filesToRemove(['readme.txt', ...names], now, { hourly: 48, daily: 30 })).not.toContain(
      'readme.txt',
    );
  });
});
