import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  FAKE_ARGON2_HASH,
  inContext,
  setContext,
  type TestDatabase,
} from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
});
afterAll(() => db.drop());

async function attempt(sql: string, params: unknown[] = []): Promise<void> {
  await api.query('BEGIN');
  try {
    await setContext(api);
    await api.query(sql, params);
  } finally {
    await api.query('ROLLBACK');
  }
}

const addUser = (username: string, extra = '') =>
  `INSERT INTO auth.users (username, display_name_ar, display_name_en, password_hash${extra ? ', ' + extra.split('=')[0] : ''})
   VALUES ('${username}', 'اسم', 'Name', '${FAKE_ARGON2_HASH}'${extra ? ', ' + extra.split('=')[1] : ''})`;

describe('users', () => {
  it('has the built-in SYSTEM user, which cannot log in or be changed', async () => {
    const { rows } = await api.query<Record<string, unknown>>(
      'SELECT username, password_hash, is_active FROM auth.users WHERE id = 1',
    );
    expect(rows[0]).toEqual({ username: 'system', password_hash: null, is_active: true });
    await expect(
      attempt(`UPDATE auth.users SET display_name_en = 'X' WHERE id = 1`),
    ).rejects.toMatchObject({
      code: 'AP003',
    });
  });

  it('checks usernames, passwords and two-factor settings', async () => {
    await expect(attempt(addUser('Bad Name'))).rejects.toMatchObject({ code: '23514' });
    await expect(
      attempt(
        `INSERT INTO auth.users (username, display_name_ar, display_name_en) VALUES ('nopass', 'ا', 'A')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(attempt(addUser('totp', 'totp_enabled=true'))).rejects.toMatchObject({
      code: '23514',
    });
    await expect(attempt(addUser('disc', 'max_discount_bp=10001'))).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('keeps usernames unique', async () => {
    await inContext(api, () => api.query(addUser('omar')));
    await expect(attempt(addUser('omar'))).rejects.toMatchObject({ code: '23505' });
  });
});

describe('roles and permissions', () => {
  it('has the five default roles; they cannot be renamed or deactivated', async () => {
    const { rows } = await api.query<{ code: string }>('SELECT code FROM auth.roles ORDER BY id');
    expect(rows.map((r) => r.code)).toEqual([
      'owner',
      'accountant',
      'cashier',
      'storekeeper',
      'technician',
    ]);
    await expect(
      attempt(`UPDATE auth.roles SET code = 'boss' WHERE code = 'owner'`),
    ).rejects.toMatchObject({
      code: 'AP003',
    });
    await expect(
      attempt(`UPDATE auth.roles SET is_active = false WHERE code = 'cashier'`),
    ).rejects.toMatchObject({
      code: 'AP003',
    });
    await attempt(`UPDATE auth.roles SET name_en = 'Head cashier' WHERE code = 'cashier'`);
  });

  it('allows custom roles', async () => {
    await inContext(api, () =>
      api.query(
        `INSERT INTO auth.roles (code, name_ar, name_en) VALUES ('supervisor', 'مشرف', 'Supervisor')`,
      ),
    );
    await inContext(api, () =>
      api.query(`UPDATE auth.roles SET is_active = false WHERE code = 'supervisor'`),
    );
  });

  it('seeds the full permission list; only the database can change it', async () => {
    const { rows } = await api.query<{ code: string; approvable: boolean }>(
      'SELECT code, approvable FROM auth.permissions ORDER BY code',
    );
    expect(rows).toHaveLength(64);
    expect(rows.filter((r) => r.approvable).map((r) => r.code)).toEqual([
      'cash.paid_out',
      'cash.variance_accept',
      'credit_notes.issue',
      'payments.refund',
      'payments.reverse',
      'pos.oversell',
      'sales.credit_over_limit',
      'sales.discount_over_limit',
      'sales.price_override',
      'shifts.recount',
      'stock.adjust_over_threshold',
    ]);
    expect(rows.map((r) => r.code)).not.toContain('pos.line_void'); // decision 0005
    await expect(
      attempt(
        `INSERT INTO auth.permissions (code, module, name_ar, name_en) VALUES ('x.y', 'x', 'س', 'X')`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('gives each default role the agreed permissions', async () => {
    const { rows } = await api.query<{ role: string; perms: string[] }>(
      `SELECT r.code AS role, array_agg(rp.permission_code ORDER BY rp.permission_code) AS perms
         FROM auth.roles r JOIN auth.role_permissions rp ON rp.role_id = r.id GROUP BY r.code`,
    );
    const perms = Object.fromEntries(rows.map((r) => [r.role, r.perms]));
    expect(perms.owner).toHaveLength(64);
    expect(perms.cashier).toEqual([
      'cash.drop',
      'cash.paid_in',
      'customers.manage',
      'customers.view',
      'documents.reprint',
      'invoices.view',
      'items.view',
      'labels.print',
      'payments.receive',
      'pos.sell',
      'reports.x',
      'shifts.close',
      'shifts.open',
    ]);
    expect(perms.storekeeper).toContain('stock.oversell_review');
    expect(perms.storekeeper).not.toContain('stock.view_cost');
    expect(perms.accountant).not.toContain('users.manage');
    expect(perms.accountant).toContain('periods.manage');
    expect(perms.technician).toEqual(['customers.view', 'items.view']);
  });

  it('records who granted a role, and allows removing it', async () => {
    const userId = await inContext(api, async () => {
      const { rows } = await api.query<{ id: string }>(`${addUser('layla')} RETURNING id`);
      return rows[0]!.id;
    });
    await inContext(api, () =>
      api.query(
        `INSERT INTO auth.user_roles (user_id, role_id) SELECT $1, id FROM auth.roles WHERE code = 'cashier'`,
        [userId],
      ),
    );
    const { rows } = await api.query<{ granted_by: string }>(
      'SELECT granted_by::text FROM auth.user_roles WHERE user_id = $1',
      [userId],
    );
    expect(rows[0]!.granted_by).toBe('1');
    await inContext(api, () =>
      api.query('DELETE FROM auth.user_roles WHERE user_id = $1', [userId]),
    );
    const removed = await api.query(
      `SELECT 1 FROM audit.log WHERE entity_type = 'auth.user_roles' AND action = 'delete' AND entity_id LIKE $1`,
      [`${userId}:%`],
    );
    expect(removed.rowCount).toBe(1);
  });
});
