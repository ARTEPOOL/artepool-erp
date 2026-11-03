/**
 * Which refusal Google's answer to the saved Drive access is (decision 0095): an ended access
 * (connect again) or a refused registration (a new client and an update); anything else, such as
 * a network failure, is neither.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRIVE_ACCESS_FILE, driveAccessProblem, readDriveAccess } from '../../src/drive-access';
import { GoogleError } from '../../src/google';

describe("Google's answer to the saved Drive access", () => {
  it('tells an ended access from a refused registration', () => {
    expect(driveAccessProblem(new GoogleError('x', 'invalid_grant'))).toBe('access_ended');
    for (const code of [
      'invalid_client',
      'unauthorized_client',
      'deleted_client',
      'disabled_client',
    ]) {
      expect(driveAccessProblem(new GoogleError('x', code)), code).toBe('registration_refused');
    }
  });

  it('is neither for a network failure, another Google error, or any other error', () => {
    expect(driveAccessProblem(new GoogleError('Google could not be reached'))).toBeNull();
    expect(driveAccessProblem(new GoogleError('x', 'rate_limit_exceeded'))).toBeNull();
    expect(driveAccessProblem(new Error('invalid_grant'))).toBeNull();
    expect(driveAccessProblem('invalid_grant')).toBeNull();
  });

  it('reads back as nothing when the file is missing or not what it should be', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'artepool-drive-access-'));
    try {
      expect(await readDriveAccess(dir)).toBeNull();
      for (const bad of ['not json', '{}', '{"checkedAt":"yesterday"}']) {
        await writeFile(join(dir, DRIVE_ACCESS_FILE), bad);
        expect(await readDriveAccess(dir), bad).toBeNull();
      }
      await writeFile(
        join(dir, DRIVE_ACCESS_FILE),
        JSON.stringify({ checkedAt: '2026-11-02T10:00:00.000Z', problem: 'other', code: 7 }),
      );
      expect(await readDriveAccess(dir)).toEqual({
        checkedAt: '2026-11-02T10:00:00.000Z',
        problem: null,
        code: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
