/**
 * Migration 0005, part 2: enrolled devices, enrollment codes, sessions, supervisor approvals,
 * recovery codes and idempotency keys (decisions 0021, 0022, 0024, 0026; architecture §5.5).
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDevice,
  createTestDatabase,
  createUser,
  FAKE_ARGON2_HASH,
  inContext,
  setContext,
  type TestDatabase,
} from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;
let admin: pg.Client;
let owner: bigint;
let office: bigint;
let pos: bigint;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  admin = await db.connect('superuser');
  owner = await createUser(api, {
    username: 'owner.main',
    signInMethod: 'password_totp',
    roles: ['owner'],
  });
  office = await createDevice(api, { code: 'OFFICE-01', kind: 'office' });
  pos = await createDevice(api, { code: 'COUNTER-01', kind: 'pos' });
});
afterAll(() => db.drop());

/** Runs statements with context and rolls back (immediate rules only). */
async function attempt(
  sql: string,
  params: unknown[] = [],
  userId = 1n,
  deviceId: bigint | null = null,
): Promise<pg.QueryResult> {
  await api.query('BEGIN');
  try {
    await setContext(api, userId, null, deviceId);
    return await api.query(sql, params);
  } finally {
    await api.query('ROLLBACK');
  }
}

const commit = (sql: string, params: unknown[] = [], userId = 1n, deviceId: bigint | null = null) =>
  inContext(api, () => api.query(sql, params), userId, deviceId);

/** Moves a row's clock back, as if time had passed (triggers are bypassed for this only). */
async function ageRow(sql: string, params: unknown[]): Promise<void> {
  await admin.query('BEGIN');
  await admin.query('SET LOCAL session_replication_role = replica');
  await admin.query(sql, params);
  await admin.query('COMMIT');
}

const auditRows = async (entityType: string, entityId: string) =>
  (
    await api.query<{ action: string; old_values: object | null; new_values: object | null }>(
      `SELECT action, old_values, new_values FROM audit.log
        WHERE entity_type = $1 AND entity_id = $2 ORDER BY id`,
      [entityType, entityId],
    )
  ).rows;

describe('devices (decisions 0024, 0026)', () => {
  it('stamps enrollment with server time and redacts the key hash in the audit log', async () => {
    const { rows } = await api.query<{ recent: boolean; status: string }>(
      `SELECT enrolled_at > now() - interval '1 minute' AS recent, status FROM auth.devices WHERE id = $1`,
      [office],
    );
    expect(rows[0]).toEqual({ recent: true, status: 'active' });
    const [insert] = await auditRows('auth.devices', office.toString());
    expect(insert!.new_values).toMatchObject({ code: 'OFFICE-01', key_hash: '[redacted]' });
  });

  it('checks device names and allows one active device per name', async () => {
    await expect(createDevice(api, { code: 'bad name' })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(createDevice(api, { code: 'office-01' })).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('stamps key renewal with server time', async () => {
    const device = await createDevice(api, { code: 'RENEW-01' });
    await commit(
      `UPDATE auth.devices SET key_hash = sha256('new key'::bytea),
              key_expires_at = now() + interval '365 days' WHERE id = $1`,
      [device],
    );
    const { rows } = await api.query<{ recent: boolean }>(
      `SELECT key_renewed_at > now() - interval '1 minute' AS recent FROM auth.devices WHERE id = $1`,
      [device],
    );
    expect(rows[0]!.recent).toBe(true);
  });

  it('revokes only with a reason, records who and when, and is final', async () => {
    const device = await createDevice(api, { code: 'LAPTOP-02' });
    await expect(
      attempt(`UPDATE auth.devices SET status = 'revoked' WHERE id = $1`, [device], owner),
    ).rejects.toMatchObject({ code: '23514' });
    await commit(
      `UPDATE auth.devices SET status = 'revoked', revoke_reason = 'Old laptop sold' WHERE id = $1`,
      [device],
      owner,
    );
    const { rows } = await api.query<{ by: string; recent: boolean }>(
      `SELECT revoked_by::text AS by, revoked_at > now() - interval '1 minute' AS recent
         FROM auth.devices WHERE id = $1`,
      [device],
    );
    expect(rows[0]).toEqual({ by: owner.toString(), recent: true });
    await expect(
      attempt(
        `UPDATE auth.devices SET status = 'active', revoke_reason = NULL WHERE id = $1`,
        [device],
        owner,
      ),
    ).rejects.toMatchObject({ code: 'AP003' });
    await expect(
      attempt(`UPDATE auth.devices SET name = 'Renamed' WHERE id = $1`, [device], owner),
    ).rejects.toMatchObject({ code: 'AP003' });
    // The same PC can come back only as a new device record.
    await createDevice(api, { code: 'LAPTOP-02' });
  });

  it('cannot be deleted', async () => {
    await expect(attempt('DELETE FROM auth.devices WHERE id = $1', [office])).rejects.toMatchObject(
      { code: '42501' },
    );
    await expect(
      admin.query('DELETE FROM auth.devices WHERE id = $1', [office]),
    ).rejects.toMatchObject({ code: 'AP002' });
  });

  it('records last contact without context and without audit rows', async () => {
    await api.query(
      `INSERT INTO auth.device_activity (device_id, last_ip, app_version) VALUES ($1, '10.0.0.5', '0.1.0')
       ON CONFLICT (device_id) DO UPDATE SET last_seen_at = now(), last_ip = EXCLUDED.last_ip`,
      [office],
    );
    const { rows } = await api.query(
      `SELECT 1 FROM audit.log WHERE entity_type = 'auth.device_activity'`,
    );
    expect(rows).toEqual([]);
  });
});

describe('enrollment codes (decision 0024)', () => {
  const newCode = (minutes = 10) =>
    commit(
      `INSERT INTO auth.enrollment_codes (origin, key_salt, code_key, expires_at)
       VALUES ('settings', substring(sha256(gen_random_uuid()::text::bytea) FROM 1 FOR 16),
               sha256('k'::bytea), now() + make_interval(mins => $1))
       RETURNING id`,
      [minutes],
      owner,
    ).then((r) => (r.rows[0] as { id: string }).id);

  it('keeps one open code at a time, valid for at most an hour', async () => {
    await expect(newCode(61)).rejects.toMatchObject({ code: '23514' });
    const first = await newCode();
    await expect(newCode()).rejects.toMatchObject({ code: '23505' });
    await commit(
      `UPDATE auth.enrollment_codes SET cancelled_at = now(), cancel_reason = 'replaced' WHERE id = $1`,
      [first],
      owner,
    );
    const second = await newCode();
    await commit(
      `UPDATE auth.enrollment_codes SET cancelled_at = now(), cancel_reason = 'cancelled' WHERE id = $1`,
      [second],
      owner,
    );
  });

  it('is used once, with server time, and never after it expires', async () => {
    const code = await newCode();
    await commit(
      `UPDATE auth.enrollment_codes SET used_at = '2000-01-01', used_device_id = $2 WHERE id = $1`,
      [code, pos],
    );
    const { rows } = await api.query<{ recent: boolean }>(
      `SELECT used_at > now() - interval '1 minute' AS recent FROM auth.enrollment_codes WHERE id = $1`,
      [code],
    );
    expect(rows[0]!.recent).toBe(true);
    await expect(
      attempt(`UPDATE auth.enrollment_codes SET failed_attempts = 1 WHERE id = $1`, [code]),
    ).rejects.toMatchObject({ code: 'AP003' });

    const expired = await newCode();
    await ageRow(
      `UPDATE auth.enrollment_codes SET created_at = now() - interval '20 minutes',
              expires_at = now() - interval '10 minutes' WHERE id = $1`,
      [expired],
    );
    await expect(
      attempt(
        `UPDATE auth.enrollment_codes SET used_at = now(), used_device_id = $2 WHERE id = $1`,
        [expired, pos],
      ),
    ).rejects.toMatchObject({ code: 'AP003' });
    await commit(
      `UPDATE auth.enrollment_codes SET cancelled_at = now(), cancel_reason = 'replaced' WHERE id = $1`,
      [expired],
      owner,
    );
  });

  it('redacts the derived key in the audit log and ignores the attempt counter', async () => {
    const code = await newCode();
    await commit(`UPDATE auth.enrollment_codes SET failed_attempts = 2 WHERE id = $1`, [code]);
    const rows = await auditRows('auth.enrollment_codes', code);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.new_values).toMatchObject({ code_key: '[redacted]', origin: 'settings' });
    await expect(attempt('DELETE FROM auth.enrollment_codes')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('sessions (decision 0021)', () => {
  let cashier: bigint;
  let clerk: bigint;

  beforeAll(async () => {
    cashier = await createUser(api, {
      username: 'ahmed.cashier',
      signInMethod: 'pin',
      roles: ['cashier'],
    });
    clerk = await createUser(api, { username: 'khaled.acc', roles: ['accountant'] });
  });

  const open = (
    userId: bigint,
    deviceId: bigint,
    method: string,
    stage = 'full',
    hours = 12,
  ): Promise<pg.QueryResult> =>
    api.query(
      `INSERT INTO auth.sessions (token_hash, user_id, device_id, stage, auth_method,
                                  idle_timeout_sec, expires_at)
       VALUES (sha256(gen_random_uuid()::text::bytea), $1, $2, $3, $4, 300,
               now() + make_interval(hours => $5))
       RETURNING id`,
      [userId, deviceId, stage, method, hours],
    );

  it('allows PIN sign-in only for PIN users on POS devices', async () => {
    await open(cashier, pos, 'pin');
    await expect(open(cashier, office, 'pin')).rejects.toMatchObject({ code: 'AP010' });
    await expect(open(cashier, pos, 'password')).rejects.toMatchObject({ code: 'AP010' });
    await expect(open(clerk, pos, 'pin')).rejects.toMatchObject({ code: 'AP010' });
    await open(clerk, office, 'password');
  });

  it('requires the 2-step code once it is set up', async () => {
    // Not set up yet: a password session is allowed so the owner can set it up.
    await open(owner, office, 'password');
    await expect(open(owner, office, 'password_totp')).rejects.toMatchObject({ code: 'AP010' });
    await commit(
      `UPDATE auth.users SET totp_secret_enc = '\\x01', totp_enabled = true WHERE id = $1`,
      [owner],
      owner,
    );
    await expect(open(owner, office, 'password')).rejects.toMatchObject({ code: 'AP010' });
    await open(owner, office, 'password', 'second_factor');
    await open(owner, office, 'password_totp');
    await open(owner, office, 'recovery_code');
    await expect(open(clerk, office, 'password_totp')).rejects.toMatchObject({ code: 'AP010' });
    await expect(open(owner, office, 'recovery_code', 'second_factor')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('refuses SYSTEM, deactivated users, revoked devices and expired device keys', async () => {
    await expect(open(1n, office, 'password')).rejects.toMatchObject({ code: 'AP010' });
    const leaver = await createUser(api, { username: 'leaver' });
    await commit(
      `UPDATE auth.users SET is_active = false, deactivation_reason = 'Resigned' WHERE id = $1`,
      [leaver],
      owner,
    );
    await expect(open(leaver, office, 'password')).rejects.toMatchObject({ code: 'AP010' });

    const revoked = await createDevice(api, { code: 'OLD-PC' });
    await commit(
      `UPDATE auth.devices SET status = 'revoked', revoke_reason = 'Stolen' WHERE id = $1`,
      [revoked],
      owner,
    );
    await expect(open(clerk, revoked, 'password')).rejects.toMatchObject({ code: 'AP010' });

    const stale = await createDevice(api, { code: 'STALE-PC' });
    await ageRow(
      `UPDATE auth.devices SET enrolled_at = now() - interval '400 days',
              key_expires_at = now() - interval '35 days' WHERE id = $1`,
      [stale],
    );
    await expect(open(clerk, stale, 'password')).rejects.toMatchObject({ code: 'AP010' });
  });

  it('lasts at most 24 hours, ends once with a reason and server time, and is never deleted', async () => {
    await expect(open(clerk, office, 'password', 'full', 25)).rejects.toMatchObject({
      code: '23514',
    });
    const id = (await open(clerk, office, 'password')).rows[0] as { id: string };
    await expect(
      api.query(`UPDATE auth.sessions SET ended_at = now() WHERE id = $1`, [id.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      api.query(`UPDATE auth.sessions SET expires_at = now() + interval '1 day' WHERE id = $1`, [
        id.id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await api.query(
      `UPDATE auth.sessions SET ended_at = '2000-01-01', end_reason = 'logout' WHERE id = $1`,
      [id.id],
    );
    const { rows } = await api.query<{ recent: boolean }>(
      `SELECT ended_at > now() - interval '1 minute' AS recent FROM auth.sessions WHERE id = $1`,
      [id.id],
    );
    expect(rows[0]!.recent).toBe(true);
    await expect(
      api.query(`UPDATE auth.sessions SET locked_at = now() WHERE id = $1`, [id.id]),
    ).rejects.toMatchObject({ code: 'AP003' });
    await expect(
      admin.query('DELETE FROM auth.sessions WHERE id = $1', [id.id]),
    ).rejects.toMatchObject({ code: 'AP002' });
  });

  it('stores only the token hash, which is unique', async () => {
    const insert = () =>
      api.query(
        `INSERT INTO auth.sessions (token_hash, user_id, device_id, stage, auth_method,
                                    idle_timeout_sec, expires_at)
         VALUES (sha256('same token'::bytea), $1, $2, 'full', 'password', 900, now() + interval '1 hour')`,
        [clerk, office],
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
    await expect(
      api.query(
        `INSERT INTO auth.sessions (token_hash, user_id, device_id, stage, auth_method,
                                    idle_timeout_sec, expires_at)
         VALUES ('plain-token'::bytea, $1, $2, 'full', 'password', 900, now() + interval '1 hour')`,
        [clerk, office],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('supervisor approvals (architecture §5.5)', () => {
  let cashier: bigint;
  let supervisor: bigint;
  let technician: bigint;

  beforeAll(async () => {
    cashier = await createUser(api, {
      username: 'sara.cashier',
      signInMethod: 'pin',
      roles: ['cashier'],
    });
    supervisor = await createUser(api, {
      username: 'yousef.acc',
      roles: ['accountant'],
      withPin: true,
    });
    technician = await createUser(api, { username: 'tech.one', roles: ['technician'] });
  });

  const approve = (
    approver: bigint,
    permission = 'sales.discount_over_limit',
    reason = 'Regular customer',
  ) =>
    commit(
      `INSERT INTO auth.approvals (permission_code, approved_by, reason_text, context)
       VALUES ($1, $2, $3, '{"discount_bp": 800, "limit_bp": 500}')
       RETURNING id, requested_by::text, device_id::text,
                 round(extract(epoch FROM expires_at - approved_at)) AS seconds`,
      [permission, approver, reason],
      cashier,
      pos,
    ).then(
      (r) => r.rows[0] as { id: string; requested_by: string; device_id: string; seconds: string },
    );

  const consume = (id: string, userId: bigint) =>
    commit(
      `UPDATE auth.approvals SET consumed_at = now(), consumed_entity = 'sales.documents:1' WHERE id = $1`,
      [id],
      userId,
      pos,
    );

  it('takes who, where and when from the context and the server clock', async () => {
    const a = await approve(supervisor);
    expect(a).toMatchObject({
      requested_by: cashier.toString(),
      device_id: pos.toString(),
      seconds: '300',
    });
    const rows = await auditRows('auth.approvals', a.id);
    expect(rows[0]!.action).toBe('insert');
  });

  it('refuses self-approval, approvers without the permission, and unapprovable actions', async () => {
    await expect(approve(cashier)).rejects.toMatchObject({ code: 'AP009' });
    await expect(approve(technician)).rejects.toMatchObject({ code: 'AP009' });
    await expect(approve(supervisor, 'users.manage')).rejects.toMatchObject({ code: 'AP009' });
    await expect(approve(supervisor, 'sales.discount_over_limit', '  ')).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      inContext(
        api,
        () =>
          api.query(
            `INSERT INTO auth.approvals (permission_code, approved_by, reason_text)
             VALUES ('pos.oversell', $1, 'Customer waiting')`,
            [supervisor],
          ),
        cashier,
      ),
    ).rejects.toMatchObject({ code: 'AP001' });
  });

  it('is used once, only by the person who asked for it', async () => {
    const a = await approve(supervisor);
    await expect(consume(a.id, technician)).rejects.toMatchObject({ code: 'AP009' });
    await consume(a.id, cashier);
    await expect(consume(a.id, cashier)).rejects.toMatchObject({ code: 'AP009' });
    const rows = await auditRows('auth.approvals', a.id);
    expect(rows.map((r) => r.action)).toEqual(['insert', 'update']);
  });

  it('cannot be used after it expires', async () => {
    const a = await approve(supervisor);
    await ageRow(
      `UPDATE auth.approvals SET approved_at = now() - interval '10 minutes',
              expires_at = now() - interval '5 minutes' WHERE id = $1`,
      [a.id],
    );
    await expect(consume(a.id, cashier)).rejects.toMatchObject({ code: 'AP009' });
  });

  it('cannot be edited or deleted', async () => {
    const a = await approve(supervisor);
    await expect(
      attempt(`UPDATE auth.approvals SET reason_text = 'changed' WHERE id = $1`, [a.id], cashier),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      admin.query('DELETE FROM auth.approvals WHERE id = $1', [a.id]),
    ).rejects.toMatchObject({ code: 'AP002' });
  });
});

describe('owner recovery codes (decision 0022)', () => {
  const addCode = (hash = FAKE_ARGON2_HASH) =>
    commit(
      'INSERT INTO auth.recovery_codes (user_id, code_hash) VALUES ($1, $2) RETURNING id',
      [owner, hash],
      owner,
    ).then((r) => (r.rows[0] as { id: string }).id);

  it('stores only Argon2id hashes, redacted in the audit log', async () => {
    await expect(addCode('ABCD-1234')).rejects.toMatchObject({ code: '23514' });
    const id = await addCode();
    const rows = await auditRows('auth.recovery_codes', id);
    expect(rows[0]!.new_values).toMatchObject({ code_hash: '[redacted]' });
  });

  it('is used or revoked once, with server time', async () => {
    const used = await addCode();
    await commit(
      `UPDATE auth.recovery_codes SET used_at = '2000-01-01' WHERE id = $1`,
      [used],
      owner,
    );
    const { rows } = await api.query<{ recent: boolean }>(
      `SELECT used_at > now() - interval '1 minute' AS recent FROM auth.recovery_codes WHERE id = $1`,
      [used],
    );
    expect(rows[0]!.recent).toBe(true);
    await expect(
      attempt(`UPDATE auth.recovery_codes SET revoked_at = now() WHERE id = $1`, [used], owner),
    ).rejects.toMatchObject({ code: 'AP003' });

    const revoked = await addCode();
    await commit(
      `UPDATE auth.recovery_codes SET revoked_at = now() WHERE id = $1`,
      [revoked],
      owner,
    );
    await expect(
      attempt(`UPDATE auth.recovery_codes SET used_at = now() WHERE id = $1`, [revoked], owner),
    ).rejects.toMatchObject({ code: 'AP003' });
  });
});

describe('idempotency keys (§4.7)', () => {
  let maint: pg.Client;

  beforeAll(async () => {
    maint = await db.connect('maint');
  });

  const store = (key: string) =>
    api.query(
      `INSERT INTO sys.idempotency_keys (key, user_id, device_id, endpoint, request_sha256,
                                         response_status, response_body)
       VALUES ($1, $2, $3, 'POST /api/v1/users', sha256('{}'::bytea), 201, '{"id": "7"}')`,
      [key, owner, office],
    );

  it('keeps the first answer, with server time, unchanged and without audit rows', async () => {
    const key = '00000000-0000-4000-8000-000000000001';
    await store(key);
    const { rows } = await api.query<{ recent: boolean }>(
      `SELECT created_at > now() - interval '1 minute' AS recent FROM sys.idempotency_keys WHERE key = $1`,
      [key],
    );
    expect(rows[0]!.recent).toBe(true);
    await expect(store(key)).rejects.toMatchObject({ code: '23505' });
    await expect(
      api.query(`UPDATE sys.idempotency_keys SET response_status = 200 WHERE key = $1`, [key]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      admin.query(`UPDATE sys.idempotency_keys SET response_status = 200 WHERE key = $1`, [key]),
    ).rejects.toMatchObject({ code: 'AP003' });
    const audit = await api.query(
      `SELECT 1 FROM audit.log WHERE entity_type = 'sys.idempotency_keys'`,
    );
    expect(audit.rows).toEqual([]);
  });

  it('can be purged only by maintenance, and only after 30 days', async () => {
    const fresh = '00000000-0000-4000-8000-000000000002';
    const old = '00000000-0000-4000-8000-000000000003';
    await store(fresh);
    await store(old);
    await ageRow(
      `UPDATE sys.idempotency_keys SET created_at = now() - interval '31 days' WHERE key = $1`,
      [old],
    );
    await expect(
      api.query('DELETE FROM sys.idempotency_keys WHERE key = $1', [old]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      maint.query('DELETE FROM sys.idempotency_keys WHERE key = $1', [fresh]),
    ).rejects.toMatchObject({ code: 'AP002' });
    const purged = await maint.query('DELETE FROM sys.idempotency_keys WHERE key = $1', [old]);
    expect(purged.rowCount).toBe(1);
    await expect(maint.query('TRUNCATE sys.idempotency_keys')).rejects.toMatchObject({
      code: '42501',
    });
  });
});
