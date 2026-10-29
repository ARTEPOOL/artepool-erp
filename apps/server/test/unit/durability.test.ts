/**
 * What keeps a confirmed sale through a power cut (M6.2 part I): which settings must be on, which
 * an upgrade sets, and which System health calls wrong (data checksums included).
 */
import { describe, expect, it } from 'vitest';
import {
  durabilityChanges,
  durabilityProblems,
  requiredDurability,
  type DurabilitySettings,
} from '../../src/platform/db/durability';

const good: DurabilitySettings = {
  fsync: 'on',
  synchronous_commit: 'on',
  full_page_writes: 'on',
  wal_sync_method: 'fsync',
  data_checksums: 'on',
};

describe('the durability settings', () => {
  it('flush through the disk cache on Windows only', () => {
    expect(requiredDurability(true).wal_sync_method).toBe('fsync');
    expect(requiredDurability(false)).not.toHaveProperty('wal_sync_method');
  });

  it('need nothing when all is on', () => {
    expect(durabilityChanges(good, true)).toEqual({});
    expect(durabilityProblems(good, true)).toEqual([]);
    expect(durabilityProblems({ ...good, wal_sync_method: 'fdatasync' }, false)).toEqual([]);
  });

  it('turn back on what was turned off, and report data checksums that are off', () => {
    const off = {
      ...good,
      fsync: 'off',
      synchronous_commit: 'off',
      wal_sync_method: 'open_datasync',
      data_checksums: 'off',
    };
    expect(durabilityChanges(off, true)).toEqual({
      fsync: 'on',
      synchronous_commit: 'on',
      wal_sync_method: 'fsync',
    });
    expect(durabilityProblems(off, true)).toEqual([
      'fsync',
      'synchronous_commit',
      'wal_sync_method',
      'data_checksums',
    ]);
  });
});
