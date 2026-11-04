/**
 * Decision 0107: the actions behind "ARTÉPOOL – Emergency tool" — the console's own code with
 * JSON answers: a reason is required, the changes are in the audit log, and nothing changes when
 * the input is wrong.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEmergencyAction, type EmergencyDeps } from '../../src/cli/emergency-actions';
import { addOwnerWithTwoStep } from '../support/https';
import { startTestServer, type TestServer } from '../support/server';

let server: TestServer;
let deps: EmergencyDeps;

beforeAll(async () => {
  server = await startTestServer();
  deps = { db: server.db, hasher: server.deps.hasher, settings: server.deps.settings };
});
afterAll(() => server.close());

const run = (action: string, input: unknown = {}) => runEmergencyAction(deps, action, input);

const lastEvent = async (action: string) =>
  server.db
    .selectFrom('audit.log')
    .select(['reason', 'action'])
    .where('action', '=', `event:${action}`)
    .orderBy('id', 'desc')
    .executeTakeFirst();

describe('emergency tool actions (decision 0107)', () => {
  it('refuses an unknown action and says when there is no owner yet', async () => {
    expect(await run('drop-everything')).toEqual({ ok: false, reason: 'unknown_action' });
    expect(await run('reset-2fa', { reason: 'phone lost' })).toEqual({
      ok: false,
      reason: 'no_owner',
    });
    expect(await run('status')).toEqual({
      ok: true,
      result: { setupComplete: false, owner: null },
    });
  });

  it('shows the owner and the 2-step state in the status', async () => {
    await addOwnerWithTwoStep(server, {
      username: 'mohammed',
      password: 'the-owner-first-password',
      recoveryCodes: ['ABCDE-FGHJK'],
    });
    expect(await run('status')).toEqual({
      ok: true,
      result: { setupComplete: false, owner: { username: 'mohammed', twoStep: true } },
    });
  });

  it('needs a reason of 3 characters and the right input, and changes nothing otherwise', async () => {
    expect(await run('reset-password', { reason: ' a ', phoneLost: false })).toEqual({
      ok: false,
      reason: 'reason_required',
    });
    expect(await run('reset-password', { reason: 'lost it' })).toEqual({
      ok: false,
      reason: 'bad_input',
    });
    expect(await run('reset-2fa', { reason: 'no' })).toEqual({
      ok: false,
      reason: 'reason_required',
    });
    expect(await lastEvent('auth.owner_password_reset')).toBeUndefined();
  });

  it('resets the password: a temporary one, shown once, in the audit log with the reason', async () => {
    const answer = await run('reset-password', { reason: 'forgot it', phoneLost: false });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.result).toMatchObject({ username: 'mohammed', twoStepCleared: false });
    const temporary = answer.result.temporaryPassword as string;
    expect(temporary.length).toBeGreaterThanOrEqual(10);
    const event = await lastEvent('auth.owner_password_reset');
    expect(event?.reason).toBe('emergency tool — forgot it');
    const audit = await server.db.selectFrom('audit.log').selectAll().execute();
    expect(
      JSON.stringify(audit, (_k, v: unknown) => (typeof v === 'bigint' ? 0 : v)),
    ).not.toContain(temporary);
  });

  it('clears the 2-step code with the reason in the audit log', async () => {
    expect(await run('reset-2fa', { reason: 'phone and codes lost' })).toEqual({
      ok: true,
      result: { username: 'mohammed' },
    });
    expect((await lastEvent('auth.owner_two_step_reset'))?.reason).toBe(
      'emergency tool — phone and codes lost',
    );
    const status = await run('status');
    expect(status).toEqual({
      ok: true,
      result: { setupComplete: false, owner: { username: 'mohammed', twoStep: false } },
    });
  });

  it('makes a one-time enrollment code', async () => {
    const answer = await run('device-code');
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.result.code).toMatch(/^[0-9A-Z-]{6,}$/);
    expect(Date.parse(answer.result.expiresAt as string)).toBeGreaterThan(Date.now());
    const row = await server.db
      .selectFrom('auth.enrollment_codes')
      .select('origin')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(row.origin).toBe('console');
  });

  it("records the cashier account's set-up (M6.4): System health at once, one audit entry", async () => {
    const health = () =>
      server.db
        .selectFrom('ops.server_health')
        .select([
          'cashier_account_state',
          'cashier_account_missing',
          'cashier_account_checked_at',
          'cashier_account_setup_at',
        ])
        .executeTakeFirstOrThrow();
    // Anything not in the expected shape changes nothing.
    for (const bad of [
      {},
      { check: { state: 'fine', missing: [] }, setupError: null, enrollmentMoved: false },
      { check: { state: 'ok', missing: ['x'] }, setupError: null, enrollmentMoved: false },
      { check: null, setupError: 'x'.repeat(501), enrollmentMoved: false },
    ]) {
      expect(await run('cashier-account', bad)).toEqual({ ok: false, reason: 'bad_input' });
    }
    expect((await health()).cashier_account_setup_at).toBeNull();

    const answer = await run('cashier-account', {
      check: { state: 'ok', missing: [] },
      setupError: null,
      enrollmentMoved: true,
    });
    expect(answer).toEqual({
      ok: true,
      result: { state: 'ok', missing: [], setupError: null, enrollmentMoved: true },
    });
    const after = await health();
    expect(after).toMatchObject({ cashier_account_state: 'ok', cashier_account_missing: [] });
    expect(after.cashier_account_setup_at).not.toBeNull();
    expect(after.cashier_account_checked_at).not.toBeNull();
    const event = await lastEvent('system.cashier_account_setup');
    expect(event?.reason).toMatch(
      /^emergency tool — cashier account set up \/ repaired by .+: ok$/,
    );

    // A set-up that stopped half way is recorded too, with its reason; the last check stays.
    const stopped = await run('cashier-account', {
      check: null,
      setupError: 'The cashier account could not be created: Access is denied.',
      enrollmentMoved: false,
    });
    expect(stopped.ok).toBe(true);
    expect((await health()).cashier_account_state).toBe('ok');
    expect((await lastEvent('system.cashier_account_setup'))?.reason).toMatch(/: failed$/);
  });
});
