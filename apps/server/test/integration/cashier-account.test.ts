/**
 * M6.4: the updater records the cashier's Windows account once an hour, as the launcher's check
 * reports it. The state is written, and audited, only when it changes; the hourly time is not
 * audited; a check that cannot run is tried again an hour later, not every minute.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectionFor } from '@artepool/node-kit';
import { createTestDatabase, inContext, type TestDatabase } from '@artepool/testing';
import {
  CASHIER_CHECK_EVERY_MS,
  parseCashierCheck,
  recordCashierAccount,
} from '../../src/cli/updater/cashier-account';

let db: TestDatabase;
let client: pg.Client;
let su: pg.Client;
let runs = 0;
let answer = '';

const HOUR = CASHIER_CHECK_EVERY_MS;
const start = new Date('2026-11-04T08:00:00.000Z');
const at = (hours: number) => new Date(start.getTime() + hours * HOUR);

const record = (now: Date) =>
  recordCashierAccount({
    db: client,
    runCheck: () => {
      runs++;
      return answer === 'throw' ? Promise.reject(new Error('exit 1')) : Promise.resolve(answer);
    },
    now: () => now,
  });

const row = async () =>
  (
    await su.query<{ state: string | null; missing: string[]; checked_at: Date | null }>(
      `SELECT cashier_account_state AS state, cashier_account_missing AS missing,
              cashier_account_checked_at AS checked_at FROM ops.server_health WHERE id = 1`,
    )
  ).rows[0]!;

const audits = async () =>
  Number(
    (
      await su.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit.log
          WHERE entity_type = 'ops.server_health' AND action = 'update'`,
      )
    ).rows[0]!.n,
  );

const line = (state: string, missing: string[] = []) =>
  `${JSON.stringify({ state, missing, account: 'artepool-pos', openFolders: [], openServices: [] })}\n`;

beforeAll(async () => {
  db = await createTestDatabase();
  su = await db.connect('superuser');
  client = new pg.Client(connectionFor('backup', db.name));
  await client.connect();
}, 120_000);
afterAll(async () => {
  await client.end();
  await su.end();
  await db.drop();
});
beforeEach(async () => {
  runs = 0;
  await inContext(su, () =>
    su.query(
      `UPDATE ops.server_health SET cashier_account_state = NULL, cashier_account_missing = '{}',
              cashier_account_checked_at = NULL WHERE id = 1`,
    ),
  );
});

describe("the launcher's answer", () => {
  it('is read from its last JSON line, and anything else is no answer', () => {
    expect(parseCashierCheck(`noise\r\n${line('repair', ['enrollment'])}`)).toEqual({
      state: 'repair',
      missing: ['enrollment'],
    });
    expect(parseCashierCheck('{"state":"error","error":"Access is denied."}')).toBeNull();
    expect(parseCashierCheck(line('fine'))).toBeNull();
    expect(parseCashierCheck(line('repair', ['password: hunter2']))).toBeNull();
    expect(parseCashierCheck('')).toBeNull();
    expect(parseCashierCheck('{not json')).toBeNull();
  });
});

describe('the hourly record', () => {
  it('writes the state once, then only the time, and audits only the change', async () => {
    answer = line('repair', ['auto_sign_in', 'enrollment']);
    const before = await audits();
    expect(await record(start)).toBe('changed');
    expect(await row()).toMatchObject({ state: 'repair', missing: ['auto_sign_in', 'enrollment'] });
    expect(await audits()).toBe(before + 1);

    // Within the hour: not checked again.
    expect(await record(at(0.5))).toBe('not_due');
    expect(runs).toBe(1);

    // An hour later, the same answer (in another order): only the time, no audit entry.
    answer = line('repair', ['enrollment', 'auto_sign_in']);
    expect(await record(at(1))).toBe('unchanged');
    expect((await row()).checked_at).toEqual(at(1));
    expect(await audits()).toBe(before + 1);

    // Repaired: written and audited.
    answer = line('ok');
    expect(await record(at(2))).toBe('changed');
    expect(await row()).toMatchObject({ state: 'ok', missing: [] });
    expect(await audits()).toBe(before + 2);
  });

  it('keeps the last state when the check cannot run, and tries again an hour later', async () => {
    answer = line('ok');
    expect(await record(start)).toBe('changed');
    answer = 'throw';
    expect(await record(at(1))).toBe('failed');
    expect(await row()).toMatchObject({ state: 'ok', checked_at: at(1) });
    expect(await record(at(1.5))).toBe('not_due');
    answer = '{"state":"error","error":"The protected store (LSA) could not be opened"}';
    expect(await record(at(2))).toBe('failed');
    expect((await row()).state).toBe('ok');
  });
});
