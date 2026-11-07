/**
 * The guided hardware check (M7 part D, decision 0119) through the API: owner only; recorded on the
 * PC it checks, with exactly that PC's steps (receipt, drawer, label, scan on a POS PC; the A4 page
 * elsewhere); all OK only when every step is; the newest check of each PC; kept as made (no change,
 * no delete) and audited; the laptop's A4 test page is a real PDF.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  FilePayload,
  HardwareCheck,
  HardwareChecksResponse,
} from '@artepool/shared/contracts';
import { isPdf, pdfHasText } from '../../src/rehearsal/pdf';
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
let pos: TestDevice;
let office: TestDevice;
let ownerPos: string;
let ownerOffice: string;
let accountant: string;

beforeAll(async () => {
  server = await startTestServer();
  pos = await addDevice(server, { code: 'COUNTER-01', kind: 'pos' });
  office = await addDevice(server, { code: 'LAPTOP-01', kind: 'office' });
  const owner = await addOwnerWithTwoStep(server, { username: 'owner.main' });
  ownerPos = (
    await openSession(server, { userId: owner.id, deviceId: pos.id, method: 'password_totp' })
  ).token;
  ownerOffice = (
    await openSession(server, { userId: owner.id, deviceId: office.id, method: 'password_totp' })
  ).token;
  const acc = await addUser(server, { username: 'khaled.acc', roles: ['accountant'] });
  accountant = (await openSession(server, { userId: acc, deviceId: office.id })).token;
  await server.admin.query('BEGIN');
  await server.admin.query("SELECT sys.set_context(1, p_reason => 'test')");
  await server.admin.query(
    `INSERT INTO sys.company_profile (id, legal_name_ar, legal_name_en, address_ar, address_en, vat_registered, trn)
     VALUES (1, 'آرتيبول', 'ARTEPOOL', 'العين', 'Al Ain', true, '100123456789012')`,
  );
  await server.admin.query('COMMIT');
});
afterAll(() => server.close());

const list = (device: TestDevice, token: string) =>
  call(server, 'GET', '/api/v1/system/hardware-checks', { device, token });
const save = (device: TestDevice, token: string, results: unknown) =>
  call(server, 'POST', '/api/v1/system/hardware-checks', {
    device,
    token,
    body: { results },
    idempotencyKey: randomUUID(),
  });
const ok = (step: string) => ({ step, outcome: 'ok' });

describe('the hardware check', () => {
  it('is the owner’s; each PC gets its own steps', async () => {
    expect(errorCode(await list(office, accountant))).toBe('PERMISSION_DENIED');
    expect(errorCode(await save(office, accountant, [ok('a4')]))).toBe('PERMISSION_DENIED');
    expect((await list(pos, ownerPos)).json<HardwareChecksResponse>()).toEqual({
      checks: [],
      steps: ['receipt', 'drawer', 'label', 'scan'],
    });
    expect((await list(office, ownerOffice)).json<HardwareChecksResponse>().steps).toEqual(['a4']);
  });

  it('records exactly this PC’s steps; all OK only when every step is', async () => {
    // A step missing, a step of another kind of PC, or one twice: refused.
    expect(errorCode(await save(pos, ownerPos, [ok('receipt'), ok('drawer'), ok('label')]))).toBe(
      'VALIDATION_FAILED',
    );
    expect(errorCode(await save(office, ownerOffice, [ok('receipt')]))).toBe('VALIDATION_FAILED');
    expect(
      errorCode(await save(pos, ownerPos, [ok('receipt'), ok('drawer'), ok('label'), ok('label')])),
    ).toBe('VALIDATION_FAILED');

    const first = await save(pos, ownerPos, [
      ok('receipt'),
      ok('drawer'),
      { step: 'label', outcome: 'problem', note: 'Faint print: darkness up' },
      ok('scan'),
    ]);
    expect(first.statusCode).toBe(201);
    expect(first.json<HardwareCheck>()).toMatchObject({
      deviceCode: 'COUNTER-01',
      allOk: false,
      results: [
        { step: 'receipt', outcome: 'ok', note: null },
        { step: 'drawer', outcome: 'ok', note: null },
        { step: 'label', outcome: 'problem', note: 'Faint print: darkness up' },
        { step: 'scan', outcome: 'ok', note: null },
      ],
    });
    // Fixed and checked again: the newest check of each PC is shown.
    const again = await save(pos, ownerPos, ['scan', 'label', 'drawer', 'receipt'].map(ok));
    expect(again.json<HardwareCheck>().allOk).toBe(true);
    expect((await save(office, ownerOffice, [ok('a4')])).statusCode).toBe(201);
    const { checks } = (await list(pos, ownerPos)).json<HardwareChecksResponse>();
    expect(checks.map((c) => [c.deviceCode, c.allOk])).toEqual([
      ['LAPTOP-01', true],
      ['COUNTER-01', true],
    ]);
    expect(checks[1]!.results.map((r) => r.step)).toEqual(['receipt', 'drawer', 'label', 'scan']);
  });

  it('is kept as made and audited', async () => {
    const { rows } = await server.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.log WHERE entity_type = 'ops.hardware_checks'`,
    );
    expect(Number(rows[0]!.n)).toBe(3);
    const api = await server.testDb.connect('api');
    try {
      await api.query('BEGIN');
      await api.query("SELECT sys.set_context(1, p_reason => 'test')");
      await expect(api.query(`UPDATE ops.hardware_checks SET all_ok = true`)).rejects.toMatchObject(
        {
          code: '42501',
        },
      );
      await api.query('ROLLBACK');
      await api.query('BEGIN');
      await api.query("SELECT sys.set_context(1, p_reason => 'test')");
      await expect(api.query(`DELETE FROM ops.hardware_checks`)).rejects.toBeTruthy();
      await api.query('ROLLBACK');
    } finally {
      await api.end();
    }
  });

  it('the laptop’s A4 test page is a real PDF', { timeout: 120_000 }, async () => {
    const page = await call(server, 'GET', '/api/v1/system/hardware-checks/a4-test-page', {
      device: office,
      token: ownerOffice,
    });
    expect(page.statusCode).toBe(200);
    const file = Buffer.from(page.json<FilePayload>().dataBase64, 'base64');
    expect(isPdf(file) && pdfHasText(file)).toBe(true);
  });
});
