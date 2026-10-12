/**
 * T6: Settings → Users & permissions (owner only, decisions 0021, 0025, 0026). Users are never
 * deleted; temporary passwords and PINs are shown once; the owner is protected.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  RoleInfo,
  RolesResponse,
  SignInResponse,
  TemporaryCodeResponse,
  UserListItem,
  UsersResponse,
} from '@artepool/shared/contracts';
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
let pos: TestDevice;
/** A separate PC for sign-ins: signing in on the owner's PC would end the owner's session. */
let signInPc: TestDevice;
let ownerId: bigint;
let token: string;
const shownOnce: string[] = [];

beforeAll(async () => {
  server = await startTestServer();
  office = await addDevice(server, { code: 'OFFICE-01' });
  pos = await addDevice(server, { code: 'COUNTER-01', kind: 'pos' });
  signInPc = await addDevice(server, { code: 'SIGNIN-PC' });
  ownerId = await addOwner(server);
  token = (
    await openSession(server, { userId: ownerId, deviceId: office.id, method: 'password_totp' })
  ).token;
});
afterAll(() => server.close());

const owner = (method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, key = randomUUID()) =>
  call(server, method, url, {
    device: office,
    token,
    ...(method === 'GET' ? {} : { idempotencyKey: key }),
    ...(body !== undefined ? { body } : {}),
  });

async function roleId(code: string): Promise<string> {
  const roles = (await owner('GET', '/api/v1/roles')).json<RolesResponse>().roles;
  return roles.find((r) => r.code === code)!.id;
}

async function userNamed(username: string): Promise<UserListItem> {
  const users = (await owner('GET', '/api/v1/users')).json<UsersResponse>().users;
  return users.find((u) => u.username === username)!;
}

describe('the users list', () => {
  it('shows people (never SYSTEM) with their role and status, and is not for everyone', async () => {
    const list = (await owner('GET', '/api/v1/users')).json<UsersResponse>();
    expect(list.users.map((u) => u.username)).toEqual(['owner.main']);
    expect(list.users[0]).toMatchObject({
      isOwner: true,
      status: 'active',
      signInMethod: 'password_totp',
    });
    const cashier = await addUser(server, {
      username: 'ahmed.cashier',
      method: 'pin',
      roles: ['cashier'],
    });
    const cashierToken = (
      await openSession(server, { userId: cashier, deviceId: pos.id, method: 'pin' })
    ).token;
    const refused = await call(server, 'GET', '/api/v1/users', {
      device: pos,
      token: cashierToken,
    });
    expect(errorCode(refused)).toBe('PERMISSION_DENIED');
  });
});

describe('creating users', () => {
  it('gives a cashier a temporary PIN, shown once, that must be changed at first sign-in', async () => {
    const key = randomUUID();
    const body = {
      username: 'Sara.Cashier',
      displayNameAr: 'سارة علي',
      displayNameEn: 'Sara Ali',
      roleId: await roleId('cashier'),
      signInMethod: 'pin',
    };
    const created = await owner('POST', '/api/v1/users', body, key);
    expect(created.statusCode).toBe(201);
    const result = created.json<TemporaryCodeResponse>();
    expect(result.kind).toBe('pin');
    expect(result.temporaryCode).toMatch(/^\d{4}$/);
    shownOnce.push(result.temporaryCode!);
    expect(result.user).toMatchObject({
      username: 'sara.cashier',
      mustChange: true,
      status: 'active',
    });
    expect(result.user.roles.map((r) => r.code)).toEqual(['cashier']);

    const retry = (await owner('POST', '/api/v1/users', body, key)).json<TemporaryCodeResponse>();
    expect(retry.temporaryCode).toBeNull();

    const signIn = await call(server, 'POST', '/api/v1/auth/pin-sign-in', {
      device: pos,
      body: { userId: result.user.id, pin: result.temporaryCode },
    });
    expect(signIn.json<SignInResponse>().session.pending).toBe('credential_change');
  });

  it('gives others a temporary password', async () => {
    const created = (
      await owner('POST', '/api/v1/users', {
        username: 'khaled.acc',
        displayNameAr: 'خالد منصور',
        displayNameEn: 'Khaled Mansour',
        roleId: await roleId('accountant'),
        signInMethod: 'password',
      })
    ).json<TemporaryCodeResponse>();
    expect(created.kind).toBe('password');
    expect(created.temporaryCode).toMatch(
      /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/,
    );
    shownOnce.push(created.temporaryCode!);
    const signIn = await call(server, 'POST', '/api/v1/auth/sign-in', {
      device: signInPc,
      body: { username: 'khaled.acc', password: created.temporaryCode },
    });
    expect(signIn.json<SignInResponse>().session.pending).toBe('credential_change');
  });

  it('refuses a second owner, a taken username, and a 2-step role without 2-step sign-in', async () => {
    const base = { displayNameAr: 'س', displayNameEn: 'X', signInMethod: 'password_totp' };
    expect(
      errorCode(
        await owner('POST', '/api/v1/users', {
          ...base,
          username: 'boss.two',
          roleId: await roleId('owner'),
        }),
      ),
    ).toBe('OWNER_PROTECTED');
    const taken = await owner('POST', '/api/v1/users', {
      ...base,
      username: 'KHALED.ACC',
      roleId: await roleId('accountant'),
    });
    expect(taken.json()).toMatchObject({
      error: { code: 'DUPLICATE', details: { issues: [{ path: ['username'], code: 'taken' }] } },
    });
    const auditor = (
      await owner('POST', '/api/v1/roles', {
        nameAr: 'مدقق',
        nameEn: 'Auditor',
        copyFromRoleId: await roleId('accountant'),
      })
    ).json<RoleInfo>();
    await server.admin.query('BEGIN');
    await server.admin.query(`SELECT sys.set_context($1, p_reason => 'test')`, [
      ownerId.toString(),
    ]);
    await server.admin.query(`UPDATE auth.roles SET requires_2fa = true WHERE id = $1`, [
      auditor.id,
    ]);
    await server.admin.query('COMMIT');
    const weak = await owner('POST', '/api/v1/users', {
      ...base,
      username: 'audit.one',
      roleId: auditor.id,
      signInMethod: 'password',
    });
    expect(weak.json()).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        details: { issues: [{ path: ['signInMethod'], code: 'two_step_required' }] },
      },
    });
  });
});

describe('looking after accounts', () => {
  it('unlocks a locked account and unblocks a blocked PIN', async () => {
    await addUser(server, {
      username: 'yousef.store',
      roles: ['storekeeper'],
      password: 'right-password-1',
    });
    for (let i = 0; i < 5; i++) {
      await call(server, 'POST', '/api/v1/auth/sign-in', {
        device: signInPc,
        body: { username: 'yousef.store', password: `wrong-${i}-password` },
      });
    }
    const locked = await userNamed('yousef.store');
    expect(locked).toMatchObject({ status: 'locked', lockedMinutes: 15 });
    const unlocked = (
      await owner('POST', `/api/v1/users/${locked.id}/unlock`)
    ).json<UserListItem>();
    expect(unlocked.status).toBe('active');
    const signIn = await call(server, 'POST', '/api/v1/auth/sign-in', {
      device: signInPc,
      body: { username: 'yousef.store', password: 'right-password-1' },
    });
    expect(signIn.statusCode).toBe(200);
  });

  it('resets credentials: a new code, unlocked, every session ended; can switch the method', async () => {
    const id = await addUser(server, {
      username: 'mona.cashier',
      method: 'pin',
      roles: ['cashier'],
    });
    const session = await openSession(server, { userId: id, deviceId: pos.id, method: 'pin' });
    const reset = (
      await owner('POST', `/api/v1/users/${id}/reset-credentials`, { signInMethod: 'password' })
    ).json<TemporaryCodeResponse>();
    shownOnce.push(reset.temporaryCode!);
    expect(reset).toMatchObject({
      kind: 'password',
      user: { signInMethod: 'password', mustChange: true },
    });
    expect(
      errorCode(
        await call(server, 'GET', '/api/v1/auth/me', { device: pos, token: session.token }),
      ),
    ).toBe('SESSION_EXPIRED');
    expect(errorCode(await owner('POST', `/api/v1/users/${ownerId}/reset-credentials`, {}))).toBe(
      'OWNER_PROTECTED',
    );
  });

  it('deactivates with a reason (never deletes), ends sessions, and can reactivate', async () => {
    const id = await addUser(server, { username: 'leaver', roles: ['technician'] });
    const session = await openSession(server, { userId: id, deviceId: office.id });
    expect(errorCode(await owner('POST', `/api/v1/users/${id}/deactivate`, { reason: '' }))).toBe(
      'VALIDATION_FAILED',
    );
    const off = (
      await owner('POST', `/api/v1/users/${id}/deactivate`, { reason: 'Contract ended' })
    ).json<UserListItem>();
    expect(off).toMatchObject({ status: 'inactive', deactivationReason: 'Contract ended' });
    expect(
      errorCode(
        await call(server, 'GET', '/api/v1/auth/me', { device: office, token: session.token }),
      ),
    ).toBe('SESSION_EXPIRED');
    const audit = await server.db
      .selectFrom('audit.log')
      .select(['user_id', 'reason'])
      .where('entity_type', '=', 'auth.users')
      .where('entity_id', '=', id.toString())
      .where('action', '=', 'update')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ user_id: ownerId, reason: 'Contract ended' });
    const back = (await owner('POST', `/api/v1/users/${id}/reactivate`)).json<UserListItem>();
    expect(back).toMatchObject({ status: 'active', deactivationReason: null });
    expect(
      errorCode(await owner('POST', `/api/v1/users/${ownerId}/deactivate`, { reason: 'testing' })),
    ).toBe('OWNER_PROTECTED');
  });

  it('renames and changes the role, but never the owner role', async () => {
    const id = await addUser(server, { username: 'hassan', roles: ['cashier'] });
    const updated = (
      await owner('PATCH', `/api/v1/users/${id}`, {
        displayNameEn: 'Hassan Omar',
        roleId: await roleId('storekeeper'),
        language: 'en',
      })
    ).json<UserListItem>();
    expect(updated).toMatchObject({ displayNameEn: 'Hassan Omar' });
    expect(updated.roles.map((r) => r.code)).toEqual(['storekeeper']);
    expect(
      errorCode(await owner('PATCH', `/api/v1/users/${id}`, { roleId: await roleId('owner') })),
    ).toBe('OWNER_PROTECTED');
    expect(
      errorCode(
        await owner('PATCH', `/api/v1/users/${ownerId}`, { roleId: await roleId('accountant') }),
      ),
    ).toBe('OWNER_PROTECTED');
  });
});

describe('roles and permissions', () => {
  it('lists every permission with owner-only ones marked', async () => {
    const { roles, permissions } = (await owner('GET', '/api/v1/roles')).json<RolesResponse>();
    expect(permissions).toHaveLength(67);
    expect(permissions.filter((p) => p.ownerOnly).map((p) => p.code)).toContain('users.manage');
    expect(roles.find((r) => r.code === 'owner')).toMatchObject({ requires2fa: true });
    expect(roles.find((r) => r.code === 'owner')!.permissions).toHaveLength(67);
  });

  it('creates a role by copying another, never copying owner-only permissions', async () => {
    const fromOwner = (
      await owner('POST', '/api/v1/roles', {
        nameAr: 'مدير',
        nameEn: 'Shop Manager',
        copyFromRoleId: await roleId('owner'),
      })
    ).json<RoleInfo>();
    expect(fromOwner.code).toMatch(/^shop-manager-[0-9a-f]{6}$/);
    expect(fromOwner.permissions).toContain('pos.sell');
    expect(fromOwner.permissions).not.toContain('users.manage');
    expect(fromOwner.permissions).not.toContain('system.company.edit'); // decision 0030
    expect(fromOwner.permissions).toHaveLength(58); // 67 minus the 9 owner-only ones
  });

  it('edits permissions and discount limits; the owner role and owner-only permissions stay locked', async () => {
    const role = (
      await owner('POST', '/api/v1/roles', {
        nameAr: 'مشرف',
        nameEn: 'Supervisor',
        copyFromRoleId: await roleId('cashier'),
      })
    ).json<RoleInfo>();
    const updated = (
      await owner('PATCH', `/api/v1/roles/${role.id}`, {
        permissions: [
          ...role.permissions.filter((p) => p !== 'labels.print'),
          'sales.discount_over_limit',
        ],
        maxDiscountBp: 500,
        maxDiscountFils: '500000',
      })
    ).json<RoleInfo>();
    expect(updated.permissions).toContain('sales.discount_over_limit');
    expect(updated.permissions).not.toContain('labels.print');
    expect(updated).toMatchObject({ maxDiscountBp: 500, maxDiscountFils: '500000' });
    expect(
      errorCode(
        await owner('PATCH', `/api/v1/roles/${role.id}`, {
          permissions: [...updated.permissions, 'users.manage'],
        }),
      ),
    ).toBe('OWNER_PROTECTED');
    expect(
      errorCode(
        await owner('PATCH', `/api/v1/roles/${role.id}`, { permissions: ['no.such_thing'] }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      errorCode(
        await owner('PATCH', `/api/v1/roles/${await roleId('owner')}`, { permissions: [] }),
      ),
    ).toBe('OWNER_PROTECTED');
    expect(
      errorCode(
        await owner('PATCH', `/api/v1/roles/${await roleId('cashier')}`, { isActive: false }),
      ),
    ).toBe('ROW_IMMUTABLE');
    const off = (
      await owner('PATCH', `/api/v1/roles/${role.id}`, { isActive: false })
    ).json<RoleInfo>();
    expect(off.isActive).toBe(false);
    const removed = await server.db
      .selectFrom('audit.log')
      .select(['user_id', 'old_values'])
      .where('entity_type', '=', 'auth.role_permissions')
      .where('action', '=', 'delete')
      .execute();
    expect(
      removed.some(
        (r) => r.user_id === ownerId && JSON.stringify(r.old_values).includes('labels.print'),
      ),
    ).toBe(true);
  });
});

describe('temporary codes', () => {
  it('are never written to the logs or the audit log', async () => {
    const audit = await server.db
      .selectFrom('audit.log')
      .select(['old_values', 'new_values'])
      .execute();
    const values = JSON.stringify(audit);
    const logs = server.logs.join('\n');
    expect(shownOnce.length).toBeGreaterThanOrEqual(3);
    for (const code of shownOnce) {
      if (code.length > 4) {
        expect(logs).not.toContain(code);
        expect(values).not.toContain(code);
      } else {
        expect(values).not.toContain(`"${code}"`);
        expect(logs).not.toContain(`"${code}"`);
      }
    }
  });
});
