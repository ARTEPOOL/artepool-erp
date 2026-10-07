/**
 * T3: the request pipeline. Every request is checked for an enrolled device, a valid session and
 * the route's permission before its handler runs; saves are idempotent; nothing secret is logged.
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { defineRoute, defineWrite } from '../../src/platform/http/route';
import {
  addDevice,
  addUser,
  ageRow,
  call,
  errorCode,
  openSession,
  startTestServer,
  type TestDevice,
  type TestServer,
} from '../support/server';

let server: TestServer;
let office: TestDevice;
let pos: TestDevice;
let ownerId: bigint;
let cashierId: bigint;
const secretsSeen: string[] = [];

const ok = () => Promise.resolve({ ok: true });

beforeAll(async () => {
  server = await startTestServer((app) => {
    defineRoute(app, { method: 'GET', url: '/t/device', access: { kind: 'device' }, handler: ok });
    defineRoute(app, {
      method: 'GET',
      url: '/t/session',
      access: { kind: 'session' },
      handler: ok,
    });
    defineRoute(app, {
      method: 'GET',
      url: '/t/locked-ok',
      access: { kind: 'session', allowLocked: true },
      handler: ok,
    });
    defineRoute(app, {
      method: 'GET',
      url: '/t/pending-ok',
      access: { kind: 'session', allowPending: true },
      handler: ok,
    });
    defineRoute(app, {
      method: 'GET',
      url: '/t/second-factor',
      access: { kind: 'session', stage: 'second_factor' },
      handler: ok,
    });
    defineRoute(app, {
      method: 'GET',
      url: '/t/users',
      access: { kind: 'permission', permission: 'users.view' },
      handler: ok,
    });
    defineWrite(app, {
      method: 'POST',
      url: '/t/branches',
      access: { kind: 'permission', permission: 'system.company.edit' },
      body: z.object({ code: z.string().regex(/^[A-Z0-9-]{2,20}$/), name: z.string().min(1) }),
      reason: () => 'pipeline test',
      handler: async ({ body, trx }) => {
        const row = await trx
          .insertInto('sys.branches')
          .values({ code: body.code, name_ar: body.name, name_en: body.name } as never)
          .returning('id')
          .executeTakeFirstOrThrow();
        const secret = `S3CR3T-${randomUUID()}`;
        secretsSeen.push(secret);
        return { status: 201, body: { id: row.id, secret }, replay: { id: row.id, secret: null } };
      },
    });
  });
  office = await addDevice(server, { code: 'OFFICE-01', kind: 'office' });
  pos = await addDevice(server, { code: 'COUNTER-01', kind: 'pos' });
  ownerId = await addUser(server, {
    username: 'owner.main',
    method: 'password_totp',
    roles: ['owner'],
  });
  await asOwner(
    `UPDATE auth.users SET totp_secret_enc = '\\x01', totp_enabled = true WHERE id = $1`,
    [ownerId],
  );
  cashierId = await addUser(server, {
    username: 'ahmed.cashier',
    method: 'pin',
    roles: ['cashier'],
  });
});
afterAll(() => server.close());

/** A change made by the owner directly in the database (fixtures the API cannot make yet). */
async function asOwner(statement: string, params: unknown[]): Promise<void> {
  await server.admin.query('BEGIN');
  await server.admin.query(`SELECT sys.set_context($1, p_reason => 'test fixture')`, [
    ownerId.toString(),
  ]);
  await server.admin.query(statement, params.map(String));
  await server.admin.query('COMMIT');
}

describe('every route declares who may use it', () => {
  it('refuses to start with a route that has no declared access', async () => {
    const app = buildApp({ logLevel: 'silent' }, server.deps);
    let refused = false;
    try {
      app.get('/no-access', () => Promise.resolve({}));
      await app.ready();
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    await app.close();
  });

  it('refuses to start with a permission that does not exist', async () => {
    const app = buildApp({ logLevel: 'silent' }, server.deps);
    defineRoute(app, {
      method: 'GET',
      url: '/typo',
      access: { kind: 'permission', permission: 'users.veiw' },
      handler: ok,
    });
    await expect(app.ready()).rejects.toThrow(/do not exist: users.veiw/);
    await app.close();
  });

  it('keeps the public surface to the health check', () => {
    const app = buildApp({ logLevel: 'silent' }, server.deps);
    const publicRoutes = app.accessTable.filter((r) => r.access.kind === 'public');
    expect(publicRoutes.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /health']);
    void app.close();
  });

  it('answers unknown addresses with a plain NOT_FOUND', async () => {
    const response = await call(server, 'GET', '/api/v1/nothing-here', { device: office });
    expect(response.statusCode).toBe(404);
    expect(errorCode(response)).toBe('NOT_FOUND');
  });

  it('is not fooled by a plain Fastify app', () => {
    // Sanity check of the test itself: without the guard, routes need no access.
    const bare = Fastify();
    expect(() => bare.get('/x', () => Promise.resolve({}))).not.toThrow();
    void bare.close();
  });
});

describe('the device check', () => {
  it('refuses requests without an enrolled device key', async () => {
    const none = await call(server, 'GET', '/t/device');
    expect(none.statusCode).toBe(401);
    expect(errorCode(none)).toBe('DEVICE_NOT_ENROLLED');
    const unknown = await call(server, 'GET', '/t/device', { device: 'x'.repeat(43) });
    expect(errorCode(unknown)).toBe('DEVICE_NOT_ENROLLED');
    const malformed = await call(server, 'GET', '/t/device', { device: 'short' });
    expect(errorCode(malformed)).toBe('DEVICE_NOT_ENROLLED');
  });

  it('accepts an enrolled PC and records when it was last seen', async () => {
    const response = await call(server, 'GET', '/t/device', { device: office });
    expect(response.statusCode).toBe(200);
    const seen = await server.db
      .selectFrom('auth.device_activity')
      .select(['app_version', 'last_ip'])
      .where('device_id', '=', office.id)
      .executeTakeFirstOrThrow();
    expect(seen).toEqual({ app_version: '0.1.0', last_ip: '127.0.0.1' });
  });

  it('refuses revoked PCs and expired device keys', async () => {
    const old = await addDevice(server, { code: 'OLD-LAPTOP' });
    await asOwner(
      `UPDATE auth.devices SET status = 'revoked', revoke_reason = 'sold' WHERE id = $1`,
      [old.id],
    );
    const revoked = await call(server, 'GET', '/t/device', { device: old });
    expect(revoked.statusCode).toBe(403);
    expect(errorCode(revoked)).toBe('DEVICE_REVOKED');

    const stale = await addDevice(server, { code: 'STALE-PC' });
    await ageRow(
      server,
      `UPDATE auth.devices SET enrolled_at = now() - interval '400 days',
              key_expires_at = now() - interval '1 day' WHERE id = $1`,
      [stale.id.toString()],
    );
    const expired = await call(server, 'GET', '/t/device', { device: stale });
    expect(expired.statusCode).toBe(401);
    expect(errorCode(expired)).toBe('DEVICE_KEY_EXPIRED');
  });

  it('refuses app versions older than the minimum', async () => {
    const tooOld = await call(server, 'GET', '/t/device', { device: office, version: '0.0.9' });
    expect(tooOld.statusCode).toBe(426);
    expect(tooOld.json()).toEqual({
      error: { code: 'CLIENT_OUTDATED', details: { minVersion: '0.1.0' } },
    });
    const missing = await call(server, 'GET', '/t/device', { device: office, version: null });
    expect(errorCode(missing)).toBe('CLIENT_OUTDATED');
    const newer = await call(server, 'GET', '/t/device', { device: office, version: '0.10.0' });
    expect(newer.statusCode).toBe(200);
  });

  it('slows down anyone guessing device keys', async () => {
    const remoteAddress = '10.9.9.9';
    for (let i = 0; i < 20; i++) {
      await call(server, 'GET', '/t/device', { device: 'y'.repeat(43), remoteAddress });
    }
    const blocked = await call(server, 'GET', '/t/device', { device: office, remoteAddress });
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked)).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Other PCs are not affected.
    expect((await call(server, 'GET', '/t/device', { device: office })).statusCode).toBe(200);
  });
});

describe('the session check', () => {
  it('needs a session token from this PC', async () => {
    const none = await call(server, 'GET', '/t/session', { device: office });
    expect(none.statusCode).toBe(401);
    expect(errorCode(none)).toBe('SESSION_REQUIRED');
    const unknown = await call(server, 'GET', '/t/session', {
      device: office,
      token: 'z'.repeat(43),
    });
    expect(errorCode(unknown)).toBe('SESSION_EXPIRED');
  });

  it('ends a session whose token is used from another PC', async () => {
    const userId = await addUser(server, { username: 'khaled.acc', roles: ['accountant'] });
    const session = await openSession(server, { userId, deviceId: office.id });
    expect(
      (await call(server, 'GET', '/t/session', { device: office, token: session.token }))
        .statusCode,
    ).toBe(200);
    const stolen = await call(server, 'GET', '/t/session', { device: pos, token: session.token });
    expect(errorCode(stolen)).toBe('SESSION_EXPIRED');
    const again = await call(server, 'GET', '/t/session', { device: office, token: session.token });
    expect(errorCode(again)).toBe('SESSION_EXPIRED');
    const row = await server.db
      .selectFrom('auth.sessions')
      .select('end_reason')
      .where('id', '=', session.id)
      .executeTakeFirstOrThrow();
    expect(row.end_reason).toBe('revoked');
    const event = await server.db
      .selectFrom('audit.log')
      .select(['user_id', 'device_id', 'new_values'])
      .where('action', '=', 'event:auth.session_ended')
      .where('entity_id', '=', session.id.toString())
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      user_id: userId,
      device_id: pos.id,
      new_values: { reason: 'revoked' },
    });
  });

  it('ends expired sessions and sessions of deactivated users', async () => {
    const userId = await addUser(server, { username: 'sara.acc', roles: ['accountant'] });
    const expired = await openSession(server, { userId, deviceId: office.id });
    await ageRow(
      server,
      `UPDATE auth.sessions SET created_at = now() - interval '13 hours',
              expires_at = now() - interval '1 hour' WHERE id = $1`,
      [expired.id.toString()],
    );
    expect(
      errorCode(await call(server, 'GET', '/t/session', { device: office, token: expired.token })),
    ).toBe('SESSION_EXPIRED');

    const live = await openSession(server, { userId, deviceId: office.id });
    await asOwner(
      `UPDATE auth.users SET is_active = false, deactivation_reason = 'left the company' WHERE id = $1`,
      [userId],
    );
    expect(
      errorCode(await call(server, 'GET', '/t/session', { device: office, token: live.token })),
    ).toBe('SESSION_EXPIRED');
    const reasons = await server.db
      .selectFrom('auth.sessions')
      .select('end_reason')
      .where('user_id', '=', userId)
      .orderBy('id')
      .execute();
    expect(reasons.map((r) => r.end_reason)).toEqual(['expired', 'user_deactivated']);
  });

  it('locks an idle session; only unlock-type routes work until it is unlocked', async () => {
    const session = await openSession(server, {
      userId: cashierId,
      deviceId: pos.id,
      method: 'pin',
      idleSeconds: 300,
    });
    await server.db
      .updateTable('auth.sessions')
      .set({ last_activity_at: sql<Date>`now() - interval '6 minutes'` })
      .where('id', '=', session.id)
      .execute();
    const locked = await call(server, 'GET', '/t/session', { device: pos, token: session.token });
    expect(locked.statusCode).toBe(423);
    expect(errorCode(locked)).toBe('SESSION_LOCKED');
    expect(
      (await call(server, 'GET', '/t/locked-ok', { device: pos, token: session.token })).statusCode,
    ).toBe(200);
    const event = await server.db
      .selectFrom('audit.log')
      .select('new_values')
      .where('action', '=', 'event:auth.session_locked')
      .where('entity_id', '=', session.id.toString())
      .executeTakeFirstOrThrow();
    expect(event.new_values).toEqual({ reason: 'idle' });
  });

  it('does not count background status checks as activity', async () => {
    const session = await openSession(server, {
      userId: cashierId,
      deviceId: pos.id,
      method: 'pin',
      idleSeconds: 300,
    });
    await server.db
      .updateTable('auth.sessions')
      .set({ last_activity_at: sql<Date>`now() - interval '1 minute'` })
      .where('id', '=', session.id)
      .execute();
    const before = await server.db
      .selectFrom('auth.sessions')
      .select('last_activity_at')
      .where('id', '=', session.id)
      .executeTakeFirstOrThrow();
    await call(server, 'GET', '/t/session', {
      device: pos,
      token: session.token,
      background: true,
    });
    const after = await server.db
      .selectFrom('auth.sessions')
      .select('last_activity_at')
      .where('id', '=', session.id)
      .executeTakeFirstOrThrow();
    expect(after.last_activity_at).toEqual(before.last_activity_at);
    await call(server, 'GET', '/t/session', { device: pos, token: session.token });
    const touched = await server.db
      .selectFrom('auth.sessions')
      .select('last_activity_at')
      .where('id', '=', session.id)
      .executeTakeFirstOrThrow();
    expect(touched.last_activity_at.getTime()).toBeGreaterThan(before.last_activity_at.getTime());
  });

  it('keeps a session waiting for the 2-step code to that step only', async () => {
    const waiting = await openSession(server, {
      userId: ownerId,
      deviceId: office.id,
      stage: 'second_factor',
    });
    const blocked = await call(server, 'GET', '/t/session', {
      device: office,
      token: waiting.token,
    });
    expect(errorCode(blocked)).toBe('SECOND_FACTOR_REQUIRED');
    expect(
      (await call(server, 'GET', '/t/second-factor', { device: office, token: waiting.token }))
        .statusCode,
    ).toBe(200);
    const full = await openSession(server, {
      userId: ownerId,
      deviceId: office.id,
      method: 'password_totp',
    });
    expect(
      errorCode(
        await call(server, 'GET', '/t/second-factor', { device: office, token: full.token }),
      ),
    ).toBe('PERMISSION_DENIED');
  });

  it('sends users who must change their password or set up 2-step there first', async () => {
    const newcomer = await addUser(server, {
      username: 'new.storekeeper',
      roles: ['storekeeper'],
      mustChange: true,
    });
    const session = await openSession(server, { userId: newcomer, deviceId: office.id });
    expect(
      errorCode(await call(server, 'GET', '/t/session', { device: office, token: session.token })),
    ).toBe('CREDENTIAL_CHANGE_REQUIRED');
    expect(
      (await call(server, 'GET', '/t/pending-ok', { device: office, token: session.token }))
        .statusCode,
    ).toBe(200);

    const auditor = await addUser(server, {
      username: 'auditor.one',
      method: 'password_totp',
      roles: ['accountant'],
    });
    const setup = await openSession(server, { userId: auditor, deviceId: office.id });
    expect(
      errorCode(await call(server, 'GET', '/t/session', { device: office, token: setup.token })),
    ).toBe('TWO_STEP_SETUP_REQUIRED');
  });
});

describe('the permission check', () => {
  it('refuses a missing permission on the server and writes it to the audit log', async () => {
    const session = await openSession(server, {
      userId: cashierId,
      deviceId: pos.id,
      method: 'pin',
    });
    const response = await call(server, 'GET', '/t/users', { device: pos, token: session.token });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: 'PERMISSION_DENIED', details: { permission: 'users.view' } },
    });
    const event = await server.db
      .selectFrom('audit.log')
      .select(['user_id', 'device_id', 'session_id', 'new_values'])
      .where('action', '=', 'event:auth.permission_denied')
      .where('user_id', '=', cashierId)
      .executeTakeFirstOrThrow();
    expect(event).toEqual({
      user_id: cashierId,
      device_id: pos.id,
      session_id: session.id,
      new_values: { permission: 'users.view', method: 'GET', route: '/t/users' },
    });
  });

  it('lets the request through when the user holds the permission', async () => {
    const session = await openSession(server, {
      userId: ownerId,
      deviceId: office.id,
      method: 'password_totp',
    });
    expect(
      (await call(server, 'GET', '/t/users', { device: office, token: session.token })).statusCode,
    ).toBe(200);
  });
});

describe('saves (one transaction, idempotent)', () => {
  let token: string;

  beforeAll(async () => {
    token = (
      await openSession(server, { userId: ownerId, deviceId: office.id, method: 'password_totp' })
    ).token;
  });

  const save = (key: string | undefined, body: unknown) =>
    call(server, 'POST', '/t/branches', {
      device: office,
      token,
      body,
      ...(key ? { idempotencyKey: key } : {}),
    });

  it('needs an idempotency key and valid fields, reporting field names only', async () => {
    const noKey = await save(undefined, { code: 'B1', name: 'Branch' });
    expect(noKey.statusCode).toBe(422);
    const bad = await save(randomUUID(), { code: 'bad code!', name: '' });
    expect(bad.json()).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        details: {
          part: 'body',
          issues: [
            { path: ['code'], code: 'invalid_format' },
            { path: ['name'], code: 'too_small' },
          ],
        },
      },
    });
    expect(bad.body).not.toContain('bad code!');
  });

  it('does the work once; a retry gets the first answer without the one-time secret', async () => {
    const key = randomUUID();
    const first = await save(key, { code: 'AIN-2', name: 'Al Ain 2' });
    expect(first.statusCode).toBe(201);
    const created = first.json<{ id: string; secret: string }>();
    expect(created.secret).toMatch(/^S3CR3T-/);
    const retry = await save(key, { code: 'AIN-2', name: 'Al Ain 2' });
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual({ id: created.id, secret: null });
    const rows = await server.db
      .selectFrom('sys.branches')
      .select('id')
      .where('code', '=', 'AIN-2')
      .execute();
    expect(rows).toHaveLength(1);
    const audit = await server.db
      .selectFrom('audit.log')
      .select(['user_id', 'device_id', 'reason'])
      .where('entity_type', '=', 'sys.branches')
      .where('entity_id', '=', created.id)
      .execute();
    expect(audit).toEqual([{ user_id: ownerId, device_id: office.id, reason: 'pipeline test' }]);
    const stored = await server.db
      .selectFrom('sys.idempotency_keys')
      .select('response_body')
      .where('key', '=', key)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(stored.response_body)).not.toContain('S3CR3T');
  });

  it('refuses the same key for a different request', async () => {
    const key = randomUUID();
    expect((await save(key, { code: 'AIN-3', name: 'Al Ain 3' })).statusCode).toBe(201);
    const other = await save(key, { code: 'AIN-4', name: 'Al Ain 4' });
    expect(other.statusCode).toBe(409);
    expect(errorCode(other)).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('does the work once even when the same request arrives twice at the same moment', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([
      save(key, { code: 'AIN-5', name: 'Al Ain 5' }),
      save(key, { code: 'AIN-5', name: 'Al Ain 5' }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json<{ id: string }>().id).toBe(b.json<{ id: string }>().id);
    const rows = await server.db
      .selectFrom('sys.branches')
      .select('id')
      .where('code', '=', 'AIN-5')
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('reports a duplicate without logging the duplicated value', async () => {
    expect((await save(randomUUID(), { code: 'DUP-777', name: 'One' })).statusCode).toBe(201);
    const dup = await save(randomUUID(), { code: 'DUP-777', name: 'Two' });
    expect(dup.statusCode).toBe(409);
    expect(errorCode(dup)).toBe('DUPLICATE');
    expect(server.logs.join('\n')).not.toContain('DUP-777');
  });
});

describe('logs', () => {
  it('never contain device keys, session tokens or secrets from request bodies', async () => {
    const all = server.logs.join('\n');
    expect(all.length).toBeGreaterThan(1000);
    for (const secret of [office.key, pos.key, ...secretsSeen]) expect(all).not.toContain(secret);
    const tokens = await server.db.selectFrom('auth.sessions').select('id').execute();
    expect(tokens.length).toBeGreaterThan(5);
    expect(all).not.toMatch(/Bearer [A-Za-z0-9_-]{43}/);
    expect(all).not.toMatch(/argon2id/);
  });
});
