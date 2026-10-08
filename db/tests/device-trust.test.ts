/**
 * Migration 0006: "Trust this PC" for the 2-step code (decision 0027). Who may trust which PC,
 * how long it lasts, when it ends by itself, and the sign-in it allows.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDevice,
  createTestDatabase,
  createUser,
  FAKE_ARGON2_HASH,
  inContext,
  type TestDatabase,
} from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;
let admin: pg.Client;
let owner: bigint;
let office: bigint;
let pos: bigint;

const commit = (sql: string, params: unknown[] = [], userId = 1n, deviceId: bigint | null = null) =>
  inContext(api, () => api.query(sql, params), userId, deviceId);

/**
 * A 2-step user who chose their own password and set up the code (the secret itself does not
 * matter here).
 */
async function twoStepUser(username: string, roles: string[] = []): Promise<bigint> {
  const id = await createUser(api, { username, signInMethod: 'password_totp', roles });
  await commit(
    `UPDATE auth.users SET totp_secret_enc = '\\x01', totp_enabled = true,
            must_change_password = false WHERE id = $1`,
    [id],
    id,
  );
  return id;
}

/** Trusts `deviceId` for `userId`, as that person on that PC. */
const trust = (
  userId: bigint,
  deviceId: bigint,
  asUser = userId,
  onDevice: bigint | null = deviceId,
) =>
  commit(
    `INSERT INTO auth.device_trust (user_id, device_id) VALUES ($1, $2) RETURNING id`,
    [userId, deviceId],
    asUser,
    onDevice,
  ).then((r) => BigInt((r.rows[0] as { id: string }).id));

const openTrust = async (userId: bigint, deviceId: bigint) =>
  (
    await api.query<{ id: string; days: number; recent: boolean }>(
      `SELECT id, extract(day FROM expires_at - created_at)::int AS days,
              created_at > now() - interval '1 minute' AS recent
         FROM auth.device_trust WHERE user_id = $1 AND device_id = $2 AND ended_at IS NULL`,
      [userId, deviceId],
    )
  ).rows;

const endReason = async (id: bigint) =>
  (
    await api.query<{ end_reason: string | null }>(
      `SELECT end_reason FROM auth.device_trust WHERE id = $1`,
      [id],
    )
  ).rows[0]!.end_reason;

const signIn = (userId: bigint, deviceId: bigint, method = 'trusted_device') =>
  api.query(
    `INSERT INTO auth.sessions (token_hash, user_id, device_id, stage, auth_method,
                                idle_timeout_sec, expires_at)
     VALUES (sha256(gen_random_uuid()::text::bytea), $1, $2, 'full', $3, 900,
             now() + interval '12 hours')`,
    [userId, deviceId, method],
  );

const setDays = (days: number) =>
  commit(`UPDATE sys.settings SET value = $1 WHERE key = 'security.trusted_device_days'`, [
    JSON.stringify(days),
  ]);

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  admin = await db.connect('superuser');
  owner = await twoStepUser('owner.main', ['owner']);
  office = await createDevice(api, { code: 'OFFICE-01', kind: 'office' });
  pos = await createDevice(api, { code: 'COUNTER-01', kind: 'pos' });
});
afterAll(() => db.drop());

describe('trusting a PC (decision 0027)', () => {
  it('lasts the set number of days from server time, and is audited', async () => {
    const id = await trust(owner, office);
    expect(await openTrust(owner, office)).toEqual([{ id: id.toString(), days: 30, recent: true }]);
    const { rows } = await api.query<{ action: string; new_values: { user_id: number } }>(
      `SELECT action, new_values FROM audit.log WHERE entity_type = 'auth.device_trust' AND entity_id = $1`,
      [id.toString()],
    );
    expect(rows.map((r) => [r.action, r.new_values.user_id])).toEqual([['insert', Number(owner)]]);
  });

  it('is given only by the person signing in, on that PC', async () => {
    const other = await createDevice(api, { code: 'OFFICE-02' });
    await expect(trust(owner, other, 1n)).rejects.toMatchObject({ code: 'AP010' });
    await expect(trust(owner, other, owner, office)).rejects.toMatchObject({ code: 'AP010' });
    await expect(trust(owner, other, owner, null)).rejects.toMatchObject({ code: 'AP010' });
  });

  it('needs an active 2-step code, and never on a POS or revoked PC', async () => {
    const plain = await createUser(api, { username: 'plain.user' });
    const spare = await createDevice(api, { code: 'SPARE-PC' });
    await expect(trust(plain, spare)).rejects.toMatchObject({ code: 'AP010' });
    await expect(trust(owner, pos)).rejects.toMatchObject({ code: 'AP010' });
    await commit(
      `UPDATE auth.devices SET status = 'revoked', revoke_reason = 'Old PC' WHERE id = $1`,
      [spare],
      owner,
    );
    await expect(trust(owner, spare)).rejects.toMatchObject({ code: 'AP010' });
  });

  it('keeps one open trust per person and PC, and is refused when the setting is 0', async () => {
    await expect(trust(owner, office)).rejects.toMatchObject({ code: '23505' });
    const laptop = await createDevice(api, { code: 'LAPTOP-01' });
    await setDays(0);
    try {
      await expect(trust(owner, laptop)).rejects.toMatchObject({ code: 'AP010' });
    } finally {
      await setDays(30);
    }
    await expect(setDays(91)).rejects.toMatchObject({ code: '23514' });
  });

  it('ends once, with a reason and server time; nothing else changes and it is never deleted', async () => {
    const laptop = await createDevice(api, { code: 'LAPTOP-02' });
    const id = await trust(owner, laptop);
    await expect(
      commit(`UPDATE auth.device_trust SET ended_at = now() WHERE id = $1`, [id], owner),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      commit(
        `UPDATE auth.device_trust SET expires_at = now() + interval '80 days' WHERE id = $1`,
        [id],
        owner,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await commit(
      `UPDATE auth.device_trust SET ended_at = '2000-01-01', end_reason = 'ended_in_settings' WHERE id = $1`,
      [id],
      owner,
    );
    const { rows } = await api.query<{ recent: boolean }>(
      `SELECT ended_at > now() - interval '1 minute' AS recent FROM auth.device_trust WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.recent).toBe(true);
    await expect(
      commit(`UPDATE auth.device_trust SET end_reason = 'replaced' WHERE id = $1`, [id], owner),
    ).rejects.toMatchObject({ code: 'AP003' });
    await expect(
      admin.query('DELETE FROM auth.device_trust WHERE id = $1', [id]),
    ).rejects.toMatchObject({
      code: 'AP002',
    });
    // A new trust may follow an ended one.
    await trust(owner, laptop);
  });
});

describe('signing in on a trusted PC (decision 0027)', () => {
  it('allows the password alone only on a PC the person trusted', async () => {
    await signIn(owner, office);
    const desk = await createDevice(api, { code: 'DESK-01' });
    await expect(signIn(owner, desk)).rejects.toMatchObject({ code: 'AP010' });
    await expect(signIn(owner, pos)).rejects.toMatchObject({ code: 'AP010' });
    // Still not a plain password session: that one stays refused for 2-step users.
    await expect(signIn(owner, office, 'password')).rejects.toMatchObject({ code: 'AP010' });
  });

  it('is refused for people without a 2-step code', async () => {
    const plain = await createUser(api, { username: 'plain.two' });
    await expect(signIn(plain, office)).rejects.toMatchObject({ code: 'AP010' });
  });

  it('follows the current setting: turned off, or shortened below the trust age', async () => {
    await setDays(0);
    try {
      await expect(signIn(owner, office)).rejects.toMatchObject({ code: 'AP010' });
    } finally {
      await setDays(30);
    }
    const [open] = await openTrust(owner, office);
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(
      `UPDATE auth.device_trust SET created_at = now() - interval '10 days' WHERE id = $1`,
      [open!.id],
    );
    await admin.query('COMMIT');
    await signIn(owner, office);
    await setDays(7);
    try {
      await expect(signIn(owner, office)).rejects.toMatchObject({ code: 'AP010' });
    } finally {
      await setDays(30);
    }
  });

  it('is refused once the trust has expired', async () => {
    const kiosk = await createDevice(api, { code: 'KIOSK-01' });
    const id = await trust(owner, kiosk);
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(
      `UPDATE auth.device_trust SET created_at = now() - interval '31 days',
              expires_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    await admin.query('COMMIT');
    await expect(signIn(owner, kiosk)).rejects.toMatchObject({ code: 'AP010' });
  });
});

describe('trust ends by itself (decision 0027)', () => {
  it('when the password changes, is reset by the owner, or the 2-step setup changes', async () => {
    const sara = await twoStepUser('sara.twostep');
    const pc = await createDevice(api, { code: 'SARA-PC' });

    let id = await trust(sara, pc);
    // A rehash of the same password (after a sign-in) is not a change.
    await commit(
      `UPDATE auth.users SET password_hash = $2 WHERE id = $1`,
      [sara, FAKE_ARGON2_HASH + 'x'],
      sara,
    );
    expect(await endReason(id)).toBeNull();
    await commit(
      `UPDATE auth.users SET password_hash = $2, password_changed_at = now() WHERE id = $1`,
      [sara, FAKE_ARGON2_HASH],
      sara,
    );
    expect(await endReason(id)).toBe('password_changed');

    id = await trust(sara, pc);
    await commit(
      `UPDATE auth.users SET password_hash = $2, must_change_password = true WHERE id = $1`,
      [sara, FAKE_ARGON2_HASH + 'y'],
      owner,
    );
    expect(await endReason(id)).toBe('password_changed');
    await commit(`UPDATE auth.users SET must_change_password = false WHERE id = $1`, [sara], sara);

    id = await trust(sara, pc);
    await commit(`UPDATE auth.users SET totp_secret_enc = '\\x02' WHERE id = $1`, [sara], sara);
    expect(await endReason(id)).toBe('two_step_changed');
  });

  it('when the person is deactivated', async () => {
    const omar = await twoStepUser('omar.twostep');
    const pc = await createDevice(api, { code: 'OMAR-PC' });
    const id = await trust(omar, pc);
    await commit(
      `UPDATE auth.users SET is_active = false, deactivation_reason = 'Resigned' WHERE id = $1`,
      [omar],
      owner,
    );
    expect(await endReason(id)).toBe('user_deactivated');
  });

  it('when the PC is revoked or becomes a POS PC; other changes keep it', async () => {
    const pcA = await createDevice(api, { code: 'TRUST-A' });
    const pcB = await createDevice(api, { code: 'TRUST-B' });
    const a = await trust(owner, pcA);
    const b = await trust(owner, pcB);
    await commit(`UPDATE auth.devices SET name = 'Back office' WHERE id = $1`, [pcA], owner);
    await commit(`UPDATE auth.devices SET device_kind = 'warehouse' WHERE id = $1`, [pcA], owner);
    expect(await endReason(a)).toBeNull();
    await commit(`UPDATE auth.devices SET device_kind = 'pos' WHERE id = $1`, [pcA], owner);
    expect(await endReason(a)).toBe('device_kind_changed');
    await commit(
      `UPDATE auth.devices SET status = 'revoked', revoke_reason = 'Stolen' WHERE id = $1`,
      [pcB],
      owner,
    );
    expect(await endReason(b)).toBe('device_revoked');
    const { rows } = await api.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.log WHERE entity_type = 'auth.device_trust' AND entity_id = $1
          AND action = 'update'`,
      [b.toString()],
    );
    expect(rows[0]!.n).toBe('1');
  });
});
