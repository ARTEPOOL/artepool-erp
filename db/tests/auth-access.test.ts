/**
 * Migration 0005, part 1: sign-in methods, deactivation with a reason, the protected owner,
 * the 2-step rule, owner-only permissions and safe security settings (decisions 0021–0026).
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  createUser,
  FAKE_ARGON2_HASH,
  inContext,
  setContext,
  type TestDatabase,
} from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;
/** The one active owner of this test database. */
let owner: bigint;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  owner = await createUser(api, {
    username: 'owner.main',
    signInMethod: 'password_totp',
    roles: ['owner'],
  });
});
afterAll(() => db.drop());

/** Runs a statement with context and rolls it back (immediate rules only). */
async function attempt(sql: string, params: unknown[] = [], userId = 1n): Promise<void> {
  await api.query('BEGIN');
  try {
    await setContext(api, userId);
    await api.query(sql, params);
  } finally {
    await api.query('ROLLBACK');
  }
}

/** Runs a statement with context and commits, so rules checked at commit apply too. */
const commit = (sql: string, params: unknown[] = [], userId = 1n) =>
  inContext(api, () => api.query(sql, params), userId);

const roleId = async (code: string): Promise<string> =>
  (await api.query<{ id: string }>('SELECT id FROM auth.roles WHERE code = $1', [code])).rows[0]!
    .id;

describe('sign-in methods (decision 0021)', () => {
  const insert = (username: string, method: string, password: string | null, pin: string | null) =>
    attempt(
      `INSERT INTO auth.users (username, display_name_ar, display_name_en, sign_in_method,
                               password_hash, pin_hash)
       VALUES ($1, 'ا', 'A', $2, $3, $4)`,
      [username, method, password, pin],
    );

  it('PIN users have a PIN and no password; everyone else has a password', async () => {
    await insert('pin.ok', 'pin', null, FAKE_ARGON2_HASH);
    await insert('pw.ok', 'password', FAKE_ARGON2_HASH, FAKE_ARGON2_HASH);
    await expect(insert('pin.nopin', 'pin', null, null)).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert('pin.withpw', 'pin', FAKE_ARGON2_HASH, FAKE_ARGON2_HASH),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(insert('pw.nopw', 'password', null, null)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert('odd', 'fingerprint', FAKE_ARGON2_HASH, null)).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('refuses anything that is not an Argon2id hash, so plain text can never be stored', async () => {
    await expect(insert('plain.pw', 'password', 'Summer2026!', null)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert('plain.pin', 'pin', null, '1234')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('allows the 2-step code only for password + 2-step users', async () => {
    await expect(
      attempt(
        `INSERT INTO auth.users (username, display_name_ar, display_name_en, password_hash,
                                 totp_secret_enc, totp_enabled)
         VALUES ('totp.pw', 'ا', 'A', $1, '\\x00', true)`,
        [FAKE_ARGON2_HASH],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('deactivating users (decision 0026)', () => {
  it('needs a reason, records who and when from the server, and can be undone', async () => {
    const user = await createUser(api, { username: 'mona.cashier', roles: ['cashier'] });

    await expect(
      attempt('UPDATE auth.users SET is_active = false WHERE id = $1', [user], owner),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      attempt(
        `UPDATE auth.users SET is_active = false, deactivation_reason = ' x ' WHERE id = $1`,
        [user],
        owner,
      ),
    ).rejects.toMatchObject({ code: '23514' });

    await commit(
      `UPDATE auth.users SET is_active = false, deactivation_reason = 'Contract ended' WHERE id = $1`,
      [user],
      owner,
    );
    const { rows } = await api.query<{ by: string; recent: boolean; reason: string }>(
      `SELECT deactivated_by::text AS by, deactivated_at > now() - interval '1 minute' AS recent,
              deactivation_reason AS reason FROM auth.users WHERE id = $1`,
      [user],
    );
    expect(rows[0]).toEqual({ by: owner.toString(), recent: true, reason: 'Contract ended' });

    const audit = await api.query<{ new_values: Record<string, unknown> }>(
      `SELECT new_values FROM audit.log
        WHERE entity_type = 'auth.users' AND entity_id = $1 AND action = 'update'
        ORDER BY id DESC LIMIT 1`,
      [user.toString()],
    );
    expect(audit.rows[0]!.new_values).toMatchObject({
      is_active: false,
      deactivation_reason: 'Contract ended',
    });

    await commit('UPDATE auth.users SET is_active = true WHERE id = $1', [user], owner);
    const back = await api.query(
      `SELECT 1 FROM auth.users WHERE id = $1 AND is_active
          AND deactivated_at IS NULL AND deactivated_by IS NULL AND deactivation_reason IS NULL`,
      [user],
    );
    expect(back.rowCount).toBe(1);
  });

  it('cannot be deleted', async () => {
    const user = await createUser(api, { username: 'no.delete' });
    await expect(attempt('DELETE FROM auth.users WHERE id = $1', [user])).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('the owner is protected (decisions 0025, 0026)', () => {
  it('allows only one active owner', async () => {
    const { rows } = await api.query<{ n: string }>(
      `SELECT count(*) AS n FROM auth.user_roles ur JOIN auth.users u ON u.id = ur.user_id
        WHERE ur.role_id = (SELECT id FROM auth.roles WHERE code = 'owner') AND u.is_active`,
    );
    expect(rows[0]!.n).toBe('1');
    await expect(
      createUser(api, { username: 'owner.two', signInMethod: 'password_totp', roles: ['owner'] }),
    ).rejects.toMatchObject({ code: 'AP008' });
  });

  it('cannot be deactivated or lose the owner role', async () => {
    await expect(
      attempt(
        `UPDATE auth.users SET is_active = false, deactivation_reason = 'testing' WHERE id = $1`,
        [owner],
      ),
    ).rejects.toMatchObject({ code: 'AP008' });
    await expect(
      attempt(
        `DELETE FROM auth.user_roles WHERE user_id = $1
            AND role_id = (SELECT id FROM auth.roles WHERE code = 'owner')`,
        [owner],
      ),
    ).rejects.toMatchObject({ code: 'AP008' });
  });

  it('keeps every permission and the 2-step requirement on the owner role', async () => {
    await expect(
      attempt(
        `DELETE FROM auth.role_permissions
          WHERE role_id = (SELECT id FROM auth.roles WHERE code = 'owner') AND permission_code = 'pos.sell'`,
      ),
    ).rejects.toMatchObject({ code: 'AP008' });
    await expect(
      attempt(`UPDATE auth.roles SET requires_2fa = false WHERE code = 'owner'`),
    ).rejects.toMatchObject({ code: 'AP008' });
  });

  it('owner-only permissions cannot be given to any other role', async () => {
    const { rows } = await api.query<{ code: string }>(
      'SELECT code FROM auth.permissions WHERE owner_only ORDER BY code',
    );
    expect(rows.map((r) => r.code)).toEqual([
      'roles.manage',
      'system.devices.manage',
      'system.series.manage',
      'system.settings.edit',
      'users.manage',
      'users.reset_credentials',
    ]);
    await expect(
      attempt(
        `INSERT INTO auth.role_permissions (role_id, permission_code) VALUES ($1, 'users.manage')`,
        [await roleId('accountant')],
      ),
    ).rejects.toMatchObject({ code: 'AP008' });
    // Ordinary permissions can still be granted and removed (the link is audited).
    await commit(
      `DELETE FROM auth.role_permissions WHERE role_id = $1 AND permission_code = 'labels.print'`,
      [await roleId('cashier')],
    );
    await commit(
      `INSERT INTO auth.role_permissions (role_id, permission_code) VALUES ($1, 'labels.print')`,
      [await roleId('cashier')],
    );
  });
});

describe('roles that require the 2-step code (decision 0021)', () => {
  it('refuses, at commit, a member who does not sign in with password + 2-step', async () => {
    await commit(
      `INSERT INTO auth.roles (code, name_ar, name_en, requires_2fa) VALUES ('auditor', 'مدقق', 'Auditor', true)`,
    );
    await expect(
      createUser(api, { username: 'pw.auditor', roles: ['auditor'] }),
    ).rejects.toMatchObject({ code: 'AP010' });
    await expect(
      createUser(api, { username: 'pin.auditor', signInMethod: 'pin', roles: ['auditor'] }),
    ).rejects.toMatchObject({ code: 'AP010' });
    const ok = await createUser(api, {
      username: 'totp.auditor',
      signInMethod: 'password_totp',
      roles: ['auditor'],
    });
    await expect(
      commit(`UPDATE auth.users SET sign_in_method = 'password' WHERE id = $1`, [ok]),
    ).rejects.toMatchObject({ code: 'AP010' });
  });

  it('refuses turning the requirement on while a member signs in without it', async () => {
    await commit(
      `INSERT INTO auth.roles (code, name_ar, name_en) VALUES ('manager', 'مدير', 'Manager')`,
    );
    await createUser(api, { username: 'pw.manager', roles: ['manager'] });
    await expect(
      commit(`UPDATE auth.roles SET requires_2fa = true WHERE code = 'manager'`),
    ).rejects.toMatchObject({ code: 'AP010' });
  });
});

describe('auth.user_has_permission', () => {
  it('follows active users, active roles and role permissions', async () => {
    const user = await createUser(api, { username: 'perm.check', roles: ['cashier'] });
    const has = async (code: string) =>
      (
        await api.query<{ ok: boolean }>('SELECT auth.user_has_permission($1, $2) AS ok', [
          user,
          code,
        ])
      ).rows[0]!.ok;
    expect(await has('pos.sell')).toBe(true);
    expect(await has('users.manage')).toBe(false);
    await commit(
      `UPDATE auth.users SET is_active = false, deactivation_reason = 'left the company' WHERE id = $1`,
      [user],
    );
    expect(await has('pos.sell')).toBe(false);
  });
});

describe('security settings (decision 0023)', () => {
  it('seeds the new settings', async () => {
    const { rows } = await api.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM sys.settings
        WHERE key IN ('security.max_failed_pins', 'security.password_min_length',
                      'security.enrollment_code_minutes', 'security.enrollment_max_attempts',
                      'security.device_key_days', 'client.min_version')
        ORDER BY key`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual({
      'client.min_version': '0.1.0',
      'security.device_key_days': 365,
      'security.enrollment_code_minutes': 10,
      'security.enrollment_max_attempts': 5,
      'security.max_failed_pins': 5,
      'security.password_min_length': 10,
    });
  });

  it('keeps every security setting in a safe range', async () => {
    const set = (key: string, value: string) =>
      attempt('UPDATE sys.settings SET value = $2::jsonb WHERE key = $1', [key, value]);
    await set('security.password_min_length', '12');
    await expect(set('security.password_min_length', '8')).rejects.toMatchObject({
      code: '23514',
    });
    await expect(set('security.max_failed_logins', '"5"')).rejects.toMatchObject({
      code: '23514',
    });
    await expect(set('security.max_failed_pins', '4.5')).rejects.toMatchObject({ code: '23514' });
    await expect(set('security.session_max_hours', '48')).rejects.toMatchObject({
      code: '23514',
    });
    await set('client.min_version', '"1.2.3"');
    await expect(set('client.min_version', '"latest"')).rejects.toMatchObject({ code: '23514' });
  });
});
