/** T6: Settings → Audit log — read only, filters, chain check, and a recorded export. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditPage, ChainStatus } from '@artepool/shared/contracts';
import {
  addDevice,
  addOwner,
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
let ownerId: bigint;
let token: string;

beforeAll(async () => {
  server = await startTestServer();
  office = await addDevice(server, { code: 'OFFICE-01' });
  ownerId = await addOwner(server);
  token = (
    await openSession(server, { userId: ownerId, deviceId: office.id, method: 'password_totp' })
  ).token;
  // Some history: a failed sign-in, a new device code, a deactivation.
  await addUser(server, { username: 'mona.cashier', method: 'pin', roles: ['cashier'] });
  await call(server, 'POST', '/api/v1/auth/sign-in', {
    device: office,
    body: { username: 'owner.main', password: 'wrong-password-123' },
  });
  await call(server, 'POST', '/api/v1/devices/enrollment-codes', {
    device: office,
    token,
    idempotencyKey: randomUUID(),
  });
});
afterAll(() => server.close());

const get = (url: string) => call(server, 'GET', url, { device: office, token });

describe('the audit log screen', () => {
  it('lists the newest first, with who, which PC and readable names', async () => {
    const page = (await get('/api/v1/audit?limit=5')).json<AuditPage>();
    expect(page.entries).toHaveLength(5);
    const ids = page.entries.map((e) => BigInt(e.id));
    expect([...ids].sort((a, b) => (a > b ? -1 : 1))).toEqual(ids);
    const code = page.entries.find((e) => e.action === 'event:auth.enrollment_code_created');
    expect(code).toMatchObject({ user: { username: 'owner.main' }, device: { code: 'OFFICE-01' } });
    const older = (await get(`/api/v1/audit?limit=5&before=${page.nextBefore}`)).json<AuditPage>();
    expect(BigInt(older.entries[0]!.id)).toBeLessThan(BigInt(page.entries.at(-1)!.id));
  });

  it('filters by kind, person, words and date, and keeps secrets redacted', async () => {
    const security = (await get('/api/v1/audit?kind=security&limit=200')).json<AuditPage>();
    expect(security.entries.length).toBeGreaterThan(0);
    expect(
      security.entries.every(
        (e) => e.action.startsWith('event:auth.') || e.entityType?.startsWith('auth.'),
      ),
    ).toBe(true);
    const failed = (await get('/api/v1/audit?q=sign_in_failed')).json<AuditPage>();
    expect(failed.entries.map((e) => e.action)).toEqual(['event:auth.sign_in_failed']);
    expect(failed.entries[0]).toMatchObject({
      entityLabel: 'owner.main',
      user: { username: 'system' },
    });
    const mine = (await get(`/api/v1/audit?userId=${ownerId}&limit=200`)).json<AuditPage>();
    expect(mine.entries.every((e) => e.user?.id === ownerId.toString())).toBe(true);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
    const todays = (
      await get(`/api/v1/audit?from=${today}&to=${today}&limit=200`)
    ).json<AuditPage>();
    expect(todays.entries.length).toBeGreaterThan(5);
    const longAgo = (await get('/api/v1/audit?from=2020-01-01&to=2020-01-02')).json<AuditPage>();
    expect(longAgo.entries).toEqual([]);
    const created = (await get('/api/v1/audit?q=mona&limit=200')).json<AuditPage>();
    const insert = created.entries.find(
      (e) => e.action === 'insert' && e.entityType === 'auth.users',
    );
    expect(insert?.newValues).toMatchObject({ username: 'mona.cashier', pin_hash: '[redacted]' });
  });

  it('shows the chain status and checks it on request, recording who asked', async () => {
    const before = (await get('/api/v1/audit/chain')).json<ChainStatus>();
    expect(before.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const checked = await call(server, 'POST', '/api/v1/audit/verify', { device: office, token });
    const status = checked.json<ChainStatus>();
    expect(status.lastCheck).toMatchObject({ ok: true, firstBadSeq: null });
    expect(Number(status.lastCheck!.rowsChecked)).toBeGreaterThan(5);
    const event = await server.db
      .selectFrom('audit.log')
      .select('user_id')
      .where('action', '=', 'event:audit.verify')
      .executeTakeFirstOrThrow();
    expect(event.user_id).toBe(ownerId);
  });

  it('exports to CSV for Excel, and the export itself is recorded', async () => {
    const response = await get('/api/v1/audit/export?kind=security');
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body.startsWith('﻿"seq","time_al_ain","user"')).toBe(true);
    expect(response.body).toContain('event:auth.sign_in_failed');
    const event = await server.db
      .selectFrom('audit.log')
      .select(['user_id', 'new_values'])
      .where('action', '=', 'event:audit.exported')
      .executeTakeFirstOrThrow();
    expect(event.user_id).toBe(ownerId);
    expect(event.new_values).toMatchObject({ filters: { kind: 'security' } });
  });

  it('is refused on the server to anyone without the permission', async () => {
    const cashier = await addUser(server, { username: 'sara.cashier', roles: ['cashier'] });
    const cashierToken = (await openSession(server, { userId: cashier, deviceId: office.id }))
      .token;
    for (const url of ['/api/v1/audit', '/api/v1/audit/chain', '/api/v1/audit/export']) {
      expect(
        errorCode(await call(server, 'GET', url, { device: office, token: cashierToken })),
      ).toBe('PERMISSION_DENIED');
    }
    expect(
      errorCode(
        await call(server, 'POST', '/api/v1/audit/verify', { device: office, token: cashierToken }),
      ),
    ).toBe('PERMISSION_DENIED');
  });
});
