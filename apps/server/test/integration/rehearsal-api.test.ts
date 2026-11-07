/**
 * «ابدأ البروفة» (M7 part B, decision 0119) on a real PostgreSQL: owner only; refused while a
 * shift is open, while an update is installing, while another rehearsal waits or runs, or with too
 * little disk; the updater takes the request (a shift opened since → red), the rehearsal program
 * writes each step and the green result with its report; a run cut off is marked red; the
 * reconciliation report of the rehearsal prints for the owner and the accountant only; a run moves
 * forward only and never changes once finished.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FilePayload, RehearsalsResponse, RehearsalRun } from '@artepool/shared/contracts';
import { claimRehearsal, runShopRehearsal } from '../../src/rehearsal/shop';
import { isPdf, pdfHasText } from '../../src/rehearsal/pdf';
import { blockedReason, REHEARSAL_MIN_FREE_BYTES } from '../../src/modules/rehearsal/service';
import { addOwnerWithTwoStep } from '../support/https';
import {
  addDevice,
  addUser,
  call,
  errorCode,
  openSession,
  startTestServer,
  type TestDevice,
  type TestServer,
} from '../support/server';

let server: TestServer;
let office: TestDevice;
let ownerToken: string;
let accountantToken: string;
let cashierToken: string;
let backup: pg.Client;
let wakes = 0;

beforeAll(async () => {
  server = await startTestServer(undefined, { updates: { wake: () => void wakes++ } });
  office = await addDevice(server, { code: 'OFFICE-01', kind: 'office' });
  const owner = await addOwnerWithTwoStep(server, { username: 'owner.main' });
  ownerToken = (
    await openSession(server, { userId: owner.id, deviceId: office.id, method: 'password_totp' })
  ).token;
  const accountant = await addUser(server, { username: 'khaled.acc', roles: ['accountant'] });
  accountantToken = (await openSession(server, { userId: accountant, deviceId: office.id })).token;
  const cashier = await addUser(server, { username: 'sara.cash', roles: ['cashier'] });
  cashierToken = (await openSession(server, { userId: cashier, deviceId: office.id })).token;
  backup = await server.testDb.connect('backup');
  // The company the printed report is headed with (the shop's, never the rehearsal's).
  await asSystem(
    `INSERT INTO sys.company_profile (id, legal_name_ar, legal_name_en, address_ar, address_en, vat_registered, trn)
     VALUES (1, 'آرتيبول', 'ARTEPOOL', 'العين', 'Al Ain', true, '100123456789012')`,
  );
});
afterAll(async () => {
  await backup.end();
  await server.close();
});

const get = (token = ownerToken) =>
  call(server, 'GET', '/api/v1/system/rehearsals', { device: office, token });
const start = (token = ownerToken) =>
  call(server, 'POST', '/api/v1/system/rehearsals', {
    device: office,
    token,
    body: {},
    idempotencyKey: randomUUID(),
  });
const refusal = async (response: ReturnType<typeof call>) => {
  const r = await response;
  return r.json<{ error: { code: string; details: { reason?: string } } }>().error;
};

/** As SYSTEM, as the updater and the rehearsal program write. */
async function asSystem(sql: string, params: unknown[] = []) {
  await server.admin.query('BEGIN');
  await server.admin.query("SELECT sys.set_context(1, p_reason => 'test')");
  try {
    await server.admin.query(sql, params);
    await server.admin.query('COMMIT');
  } catch (error) {
    await server.admin.query('ROLLBACK');
    throw error;
  }
}

/** An open shift, as in the updater's test (triggers and keys aside: only "is one open" matters). */
async function openShift(): Promise<() => Promise<void>> {
  const su = server.admin;
  await su.query('SET session_replication_role = replica');
  await su.query(
    `INSERT INTO cash.shifts (series_id, seq_no, shift_number, register_id, cashier_id,
                              opened_by, opening_float_fils, created_by, updated_by)
     VALUES (1, 1, 'SH-REH', 1, 1, 1, 0, 1, 1)`,
  );
  await su.query('SET session_replication_role = DEFAULT');
  return async () => {
    await su.query('SET session_replication_role = replica');
    await su.query(`DELETE FROM cash.shifts WHERE shift_number = 'SH-REH'`);
    await su.query('SET session_replication_role = DEFAULT');
  };
}

describe('the automated rehearsal from System health', () => {
  it('is for the owner only; the reconciliation print also for the accountant', async () => {
    expect(errorCode(await get(accountantToken))).toBe('PERMISSION_DENIED');
    expect(errorCode(await start(accountantToken))).toBe('PERMISSION_DENIED');
    expect(errorCode(await get(cashierToken))).toBe('PERMISSION_DENIED');
    const nothing = (await get()).json<RehearsalsResponse>();
    expect(nothing).toEqual({ latest: null, history: [], blocked: null });
  });

  it('is refused while a shift is open, an update is installing, or the disk is nearly full', async () => {
    const close = await openShift();
    expect((await get()).json<RehearsalsResponse>().blocked).toBe('shift_open');
    expect(await refusal(start())).toMatchObject({
      code: 'RULE_VIOLATION',
      details: { reason: 'shift_open' },
    });
    await close();
    await asSystem(`UPDATE ops.update_state SET waiting_reason = 'installing' WHERE id = 1`);
    expect(await refusal(start())).toMatchObject({ details: { reason: 'update_installing' } });
    await asSystem(`UPDATE ops.update_state SET waiting_reason = NULL WHERE id = 1`);
    expect(await blockedReason(server.db, REHEARSAL_MIN_FREE_BYTES - 1)).toBe('low_disk');
    expect(await blockedReason(server.db, REHEARSAL_MIN_FREE_BYTES)).toBeNull();
  });

  it('a request wakes the updater; one at a time; the updater takes it', async () => {
    const before = wakes;
    const asked = await start();
    expect(asked.statusCode).toBe(201);
    const run = asked.json<RehearsalRun>();
    expect(run).toMatchObject({ status: 'requested', steps: [], result: null });
    expect(wakes).toBe(before + 1);
    expect(await refusal(start())).toMatchObject({ details: { reason: 'running' } });
    expect(await claimRehearsal(backup)).toEqual({ kind: 'start', id: run.id });
    expect(await claimRehearsal(backup)).toEqual({ kind: 'none' });
    expect((await get()).json<RehearsalsResponse>().latest).toMatchObject({
      id: run.id,
      status: 'running',
    });
  });

  it(
    'the program plays the day and keeps the green result, steps and report',
    { timeout: 600_000 },
    async () => {
      const { latest } = (await get()).json<RehearsalsResponse>();
      const report = await runShopRehearsal(backup, latest!.id, {
        size: { name: 'shop', tills: 2, salesPerTill: 6, items: 20 },
        heartbeatMs: 1_000,
      });
      expect(report.steps.filter((s) => !s.ok)).toEqual([]);
      const kept = (await get()).json<RehearsalsResponse>().latest!;
      expect(kept).toMatchObject({ status: 'passed', failure: null });
      expect(kept.steps.map((s) => s.step)).toEqual(report.steps.map((s) => s.step));
      expect(kept.result?.reconciliation?.ok).toBe(true);
      expect(Object.values(kept.result?.checks ?? {}).every((c) => c.ok)).toBe(true);
      expect(kept.result?.speed?.sale.samples).toBeGreaterThan(0);

      // The reconciliation report of the rehearsal prints for the owner and the accountant.
      for (const token of [ownerToken, accountantToken]) {
        const pdf = await call(
          server,
          'GET',
          `/api/v1/system/rehearsals/${kept.id}/reconciliation/pdf`,
          { device: office, token },
        );
        expect(pdf.statusCode, pdf.body).toBe(200);
        const file = Buffer.from(pdf.json<FilePayload>().dataBase64, 'base64');
        expect(isPdf(file) && pdfHasText(file)).toBe(true);
      }
      expect(
        errorCode(
          await call(server, 'GET', `/api/v1/system/rehearsals/${kept.id}/reconciliation/pdf`, {
            device: office,
            token: cashierToken,
          }),
        ),
      ).toBe('PERMISSION_DENIED');

      // A finished run never changes.
      await expect(
        asSystem(`UPDATE ops.rehearsal_runs SET failure = 'x' WHERE id = $1`, [kept.id]),
      ).rejects.toBeTruthy();
    },
  );

  it('a run cut off half way is marked red; a shift opened before it starts makes it red', async () => {
    const cut = (await start()).json<RehearsalRun>();
    expect(await claimRehearsal(backup)).toEqual({ kind: 'start', id: cut.id });
    await asSystem(
      `UPDATE ops.rehearsal_runs SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1`,
      [cut.id],
    );
    expect(await claimRehearsal(backup)).toEqual({ kind: 'none' });
    const red = (await get()).json<RehearsalsResponse>();
    expect(red.latest).toMatchObject({ id: cut.id, status: 'failed' });
    expect(red.latest!.failure).toMatch(/stopped half way/);
    expect(red.history.length).toBeGreaterThanOrEqual(1);

    const asked = (await start()).json<RehearsalRun>();
    const close = await openShift();
    try {
      expect(await claimRehearsal(backup)).toEqual({
        kind: 'refused',
        id: asked.id,
        reason: 'shift_open',
      });
    } finally {
      await close();
    }
    expect((await get()).json<RehearsalsResponse>().latest).toMatchObject({
      id: asked.id,
      status: 'failed',
    });
  });

  it('only the owner asks, and the API cannot write a run’s progress or result', async () => {
    const api = await server.testDb.connect('api');
    try {
      await api.query('BEGIN');
      await api.query("SELECT sys.set_context(1, p_reason => 'test')");
      await expect(
        api.query(`UPDATE ops.rehearsal_runs SET status = 'passed'`),
      ).rejects.toMatchObject({ code: '42501' });
      await api.query('ROLLBACK');
      await api.query('BEGIN');
      await api.query("SELECT sys.set_context(1, p_reason => 'test')");
      await expect(
        api.query(`INSERT INTO ops.rehearsal_runs (size) VALUES ('shop')`),
      ).rejects.toMatchObject({ code: 'AP010' });
      await api.query('ROLLBACK');
    } finally {
      await api.end();
    }
  });
});
