/**
 * Migration 0043 (M6.2 part C): the first-run setup state only moves forward and is never deleted;
 * a database that already has an owner is marked complete; and nothing can be recorded while the
 * server clock is more than 2 minutes behind the latest record, except the alert about it.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@artepool/migrate';
import { migrationsDir } from '@artepool/node-kit';
import {
  createEmptyTestDatabase,
  createTestDatabase,
  createUser,
  inContext,
  setContext,
  type TestDatabase,
} from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;
let admin: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  admin = await db.connect('superuser');
});
afterAll(() => db.drop());

/** Runs `sql` as the API with a context, and reports the refusal (hint or message), if any. */
async function refusal(sql: string, params: unknown[] = []): Promise<string | null> {
  await api.query('BEGIN');
  try {
    await setContext(api, 1n, 'test');
    await api.query(sql, params);
    await api.query('COMMIT');
    return null;
  } catch (error) {
    await api.query('ROLLBACK');
    const e = error as { hint?: string; message: string };
    return e.hint ?? e.message;
  }
}

const state = async () =>
  (
    await api.query<{ state: string; path: string | null; started: boolean; completed: boolean }>(
      `SELECT state, path, started_at IS NOT NULL AS started, completed_at IS NOT NULL AS completed
         FROM sys.setup_state`,
    )
  ).rows;

describe('the first-run setup state', () => {
  it('starts as not started on a new database, with an installation ID', async () => {
    expect(await state()).toEqual([
      { state: 'not_started', path: null, started: false, completed: false },
    ]);
    const { rows } = await api.query<{ id: string }>(
      'SELECT installation_id AS id FROM sys.setup_state',
    );
    expect(rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('moves forward one step at a time and never back; the path is chosen once', async () => {
    // Not straight to complete, and not in progress without a path.
    expect(await refusal(`UPDATE sys.setup_state SET state = 'complete'`)).toBe(
      'SETUP_ALREADY_DONE',
    );
    expect(await refusal(`UPDATE sys.setup_state SET state = 'in_progress'`)).toMatch(
      /setup_state_shape_ck/,
    );
    expect(
      await refusal(`UPDATE sys.setup_state SET state = 'in_progress', path = 'new'`),
    ).toBeNull();
    expect(await state()).toEqual([
      { state: 'in_progress', path: 'new', started: true, completed: false },
    ]);
    // A step may be repeated while in progress; the path stays.
    expect(await refusal(`UPDATE sys.setup_state SET state = 'in_progress'`)).toBeNull();
    expect(await refusal(`UPDATE sys.setup_state SET path = 'restore'`)).toMatch(
      /path was already chosen/,
    );
    expect(await refusal(`UPDATE sys.setup_state SET state = 'not_started', path = NULL`)).toBe(
      'SETUP_ALREADY_DONE',
    );
    expect(await refusal(`UPDATE sys.setup_state SET state = 'complete'`)).toBeNull();
    expect(await state()).toEqual([
      { state: 'complete', path: 'new', started: true, completed: true },
    ]);
    // Once complete, nothing changes, not even "complete" again.
    for (const change of [`state = 'in_progress'`, `state = 'complete'`]) {
      expect(await refusal(`UPDATE sys.setup_state SET ${change}`)).toBe('SETUP_ALREADY_DONE');
    }
  });

  it('cannot be deleted, emptied or given a second row, and every change is audited', async () => {
    expect(await refusal('DELETE FROM sys.setup_state')).not.toBeNull();
    expect(await refusal(`INSERT INTO sys.setup_state (id) VALUES (2)`)).not.toBeNull();
    await expect(admin.query('TRUNCATE sys.setup_state')).rejects.toThrow();
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.log WHERE entity_type = 'sys.setup_state' AND action = 'update'`,
    );
    expect(Number(rows[0]!.n)).toBe(2); // started, completed (a repeated step changes nothing)
  });

  it('is complete at once on a database that already has an owner', async () => {
    const older = mkdtempSync(join(tmpdir(), 'artepool-0042-'));
    const empty = await createEmptyTestDatabase();
    try {
      for (const file of readdirSync(migrationsDir).filter((f) => f < '0043')) {
        cpSync(join(migrationsDir, file), join(older, file));
      }
      const migrator = await empty.connect('migrator');
      await migrate({ client: migrator, dir: older });
      const superuser = await empty.connect('superuser');
      await createUser(superuser, {
        username: 'mohammed',
        signInMethod: 'password_totp',
        roles: ['owner'],
      });
      await migrate({ client: migrator, dir: migrationsDir });
      const { rows } = await superuser.query<{ state: string; completed: boolean }>(
        'SELECT state, completed_at IS NOT NULL AS completed FROM sys.setup_state',
      );
      expect(rows).toEqual([{ state: 'complete', completed: true }]);
    } finally {
      await empty.drop();
      rmSync(older, { recursive: true, force: true });
    }
  });
});

describe('the clock guard', () => {
  /** A record dated `minutes` from now, as if the clock had been there a moment ago. */
  async function recordAt(minutes: number): Promise<void> {
    await inContext(admin, async () => {
      await admin.query(
        `INSERT INTO audit.log (user_id, action, entity_type, occurred_at)
         VALUES (1, 'event:test.clock', 'test', clock_timestamp() + make_interval(mins => $1))`,
        [minutes],
      );
    });
  }
  const write = () =>
    refusal(`INSERT INTO sys.alerts (alert_type, severity, dedupe_key)
             VALUES ('low_stock', 'info', 'clock-test-' || gen_random_uuid())`);

  it('allows normal drift (up to 2 minutes behind the latest record)', async () => {
    await recordAt(1);
    expect(await write()).toBeNull();
    const { rows } = await api.query<{ is_behind: boolean }>(
      'SELECT is_behind FROM sys.clock_status()',
    );
    expect(rows[0]!.is_behind).toBe(false);
  });

  it('refuses every write when the clock is further behind, except the alert about it', async () => {
    await recordAt(10);
    expect(await write()).toBe('CLOCK_BACKWARDS');
    const { rows } = await api.query<{ is_behind: boolean; latest: Date }>(
      'SELECT is_behind, latest_record_at AS latest FROM sys.clock_status()',
    );
    expect(rows[0]!.is_behind).toBe(true);
    // The "server clock went back" alert gets through, so the owner hears about it.
    expect(
      await refusal(`INSERT INTO sys.alerts (alert_type, severity, dedupe_key)
                     VALUES ('clock_backwards', 'critical', 'clock_backwards:test')`),
    ).toBeNull();
    // A different alert in the same transaction does not slip through with it.
    expect(
      await refusal(`INSERT INTO sys.alerts (alert_type, severity, dedupe_key)
                     VALUES ('clock_backwards', 'critical', 'clock_backwards:test2'),
                            ('low_stock', 'info', 'clock-test-2')`),
    ).toBe('CLOCK_BACKWARDS');
  });

  it('keeps the audit chain whole', async () => {
    const { rows } = await admin.query<{ ok: boolean }>(
      'SELECT bool_and(ok) AS ok FROM audit.verify_chain()',
    );
    expect(rows[0]!.ok).toBe(true);
  });
});
