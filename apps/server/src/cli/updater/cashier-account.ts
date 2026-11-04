/**
 * The cashier's Windows account on System health (M6.4): once an hour the server PC's updater
 * (SYSTEM) runs `artepool-svc cashier-account check` and records what it says in
 * ops.server_health. The state and the missing items are written, and audited, only when they
 * change; the check time is written every hour (not audited, migration 0051). A check that cannot
 * run records only its time, so it is tried again an hour later, not every minute.
 */
import type pg from 'pg';
import { z } from 'zod';
import { inSystemTx } from '@artepool/backup';
import { CASHIER_ACCOUNT_ITEMS, CASHIER_ACCOUNT_STATES } from '@artepool/shared/contracts';

export const CASHIER_CHECK_EVERY_MS = 60 * 60 * 1000;

const checkSchema = z.object({
  state: z.enum(CASHIER_ACCOUNT_STATES),
  missing: z.array(z.enum(CASHIER_ACCOUNT_ITEMS)).max(CASHIER_ACCOUNT_ITEMS.length),
});
export type CashierCheck = z.infer<typeof checkSchema>;

/** The launcher's JSON line (the last one printed); an error answer or anything else is null. */
export function parseCashierCheck(output: string): CashierCheck | null {
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith('{'));
  if (!line) return null;
  try {
    const parsed = checkSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const sameItems = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((item, i) => item === [...b].sort()[i]);

export type CashierRecord = 'not_due' | 'unchanged' | 'changed' | 'failed';

export async function recordCashierAccount(deps: {
  /** As the backup role (the updater's connection). */
  db: pg.Client;
  /** Runs the launcher's check and returns its standard output. */
  runCheck: () => Promise<string>;
  now: () => Date;
}): Promise<CashierRecord> {
  const { db } = deps;
  const now = deps.now();
  const { rows } = await db.query<{
    state: string | null;
    missing: string[];
    checked_at: Date | null;
  }>(
    `SELECT cashier_account_state AS state, cashier_account_missing AS missing,
            cashier_account_checked_at AS checked_at
       FROM ops.server_health WHERE id = 1`,
  );
  const row = rows[0];
  if (!row) return 'failed';
  if (row.checked_at && now.getTime() - row.checked_at.getTime() < CASHIER_CHECK_EVERY_MS) {
    return 'not_due';
  }
  const check = await deps.runCheck().then(parseCashierCheck, () => null);
  if (!check) {
    await inSystemTx(db, 'updater: cashier account check did not run', () =>
      db.query('UPDATE ops.server_health SET cashier_account_checked_at = $1 WHERE id = 1', [now]),
    );
    return 'failed';
  }
  const same = row.state === check.state && sameItems(row.missing, check.missing);
  if (same) {
    await inSystemTx(db, 'updater: cashier account checked', () =>
      db.query('UPDATE ops.server_health SET cashier_account_checked_at = $1 WHERE id = 1', [now]),
    );
    return 'unchanged';
  }
  await inSystemTx(db, `updater: cashier account ${check.state}`, () =>
    db.query(
      `UPDATE ops.server_health
          SET cashier_account_state = $2, cashier_account_missing = $3,
              cashier_account_checked_at = $1
        WHERE id = 1`,
      [now, check.state, check.missing],
    ),
  );
  return 'changed';
}
