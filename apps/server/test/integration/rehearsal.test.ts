/**
 * The automated rehearsal (M7 part B, decision 0119) on a real PostgreSQL: a small day played
 * through the real API ends green, every step, check and restored check; its database is gone
 * afterwards; and the drop refuses any database that is not a rehearsal's own.
 */
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { connectionFor } from '@artepool/node-kit';
import {
  createRehearsalDatabase,
  dropRehearsalDatabase,
  isRehearsalName,
} from '../../src/rehearsal/database';
import { runRehearsal } from '../../src/rehearsal/run';
import { SCRIPT_STEPS, type RehearsalSize } from '../../src/rehearsal/script';

const SMALL: RehearsalSize = { name: 'shop', tills: 2, salesPerTill: 12, items: 40 };

async function databaseExists(name: string): Promise<boolean> {
  const admin = new pg.Client({ ...connectionFor('superuser'), database: 'postgres' });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return rows.length > 0;
  } finally {
    await admin.end();
  }
}

describe('the automated rehearsal', () => {
  it(
    'plays every case of the day through the API and ends green',
    { timeout: 600_000 },
    async () => {
      const seen: string[] = [];
      const report = await runRehearsal(SMALL, {
        progress: (outcome) => {
          seen.push(outcome.step);
        },
      });
      const red = report.steps.filter((s) => !s.ok);
      expect(red, JSON.stringify(red, null, 2)).toEqual([]);
      expect(report.ok).toBe(true);
      for (const name of [
        ...SCRIPT_STEPS,
        'database',
        'server',
        'day',
        'checks',
        'backup_restore',
        'speed',
      ])
        expect(seen).toContain(name);
      expect(Object.values(report.checks ?? {}).every((c) => c.ok)).toBe(true);
      expect(Object.keys(report.restoredChecks ?? {})).toEqual(Object.keys(report.checks ?? {}));
      expect(report.totals).toMatchObject({ shifts: SMALL.tills, labelPrints: 3 });
      expect(report.totals!.posSales).toBeGreaterThanOrEqual(SMALL.tills * SMALL.salesPerTill);
      expect(report.totals!.posReturns).toBe(2);
      expect(report.totals!.approvals).toBeGreaterThanOrEqual(7);
      expect(report.speed!.sale.samples).toBeGreaterThan(0);

      // Nothing is left behind.
      let leftovers: string;
      const admin = new pg.Client({ ...connectionFor('superuser'), database: 'postgres' });
      await admin.connect();
      try {
        const { rows } = await admin.query<{ datname: string }>(
          `SELECT datname FROM pg_database WHERE datname LIKE 'artepool\\_rehearsal\\_%'`,
        );
        leftovers = rows.map((r) => r.datname).join(', ');
      } finally {
        await admin.end();
      }
      expect(leftovers).toBe('');
    },
  );

  it('drops only its own databases', { timeout: 120_000 }, async () => {
    expect(isRehearsalName('artepool_rehearsal_0123456789ab')).toBe(true);
    for (const name of [
      'artepool_dev',
      'artepool_rehearsal_x',
      'artepool_rehearsal_0123456789ab_restore_test',
    ])
      expect(isRehearsalName(name)).toBe(false);
    await expect(dropRehearsalDatabase('artepool_dev')).rejects.toThrow(/not a rehearsal database/);

    // A database with the right name but without the mark (or with another run's mark) stays.
    const own = await createRehearsalDatabase();
    try {
      await expect(dropRehearsalDatabase(own.name, 'f'.repeat(32))).rejects.toThrow(/mark/);
      expect(await databaseExists(own.name)).toBe(true);
    } finally {
      await dropRehearsalDatabase(own.name, own.token);
    }
    expect(await databaseExists(own.name)).toBe(false);

    const admin = new pg.Client({ ...connectionFor('superuser'), database: 'postgres' });
    await admin.connect();
    const unmarked = 'artepool_rehearsal_aaaaaaaaaaaa';
    try {
      await admin.query(`CREATE DATABASE ${unmarked}`);
      await expect(dropRehearsalDatabase(unmarked)).rejects.toThrow(/mark/);
      expect(await databaseExists(unmarked)).toBe(true);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${unmarked}`);
      await admin.end();
    }
  });
});
