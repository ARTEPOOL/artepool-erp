import type pg from 'pg';
import { inContext } from './context';

/**
 * A syntactically valid Argon2id hash for test rows. The database refuses any password, PIN or
 * recovery-code hash that is not Argon2id, so a plain-text secret can never be stored by mistake.
 */
export const FAKE_ARGON2_HASH = '$argon2id$v=19$m=65536,t=3,p=1$dGVzdHNhbHQ$dGVzdGhhc2g';

export interface UserFixture {
  username: string;
  signInMethod?: 'pin' | 'password' | 'password_totp';
  roles?: string[];
  /** Adds a PIN hash to a password user (PIN users always get one). */
  withPin?: boolean;
}

/** Creates a user (as SYSTEM) with the given roles and returns its id. */
export async function createUser(client: pg.Client, fixture: UserFixture): Promise<bigint> {
  const method = fixture.signInMethod ?? 'password';
  const password = method === 'pin' ? null : FAKE_ARGON2_HASH;
  const pin = method === 'pin' || fixture.withPin ? FAKE_ARGON2_HASH : null;
  return inContext(client, async () => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO auth.users (username, display_name_ar, display_name_en, sign_in_method,
                               password_hash, pin_hash)
       VALUES ($1, 'مستخدم', 'User', $2, $3, $4) RETURNING id`,
      [fixture.username, method, password, pin],
    );
    const id = rows[0]!.id;
    for (const role of fixture.roles ?? []) {
      await client.query(
        'INSERT INTO auth.user_roles (user_id, role_id) SELECT $1, id FROM auth.roles WHERE code = $2',
        [id, role],
      );
    }
    return BigInt(id);
  });
}

export interface DeviceFixture {
  code: string;
  kind?: 'pos' | 'office' | 'warehouse' | 'server';
  /** Days until the device key expires (default 365). */
  keyDays?: number;
}

/** Enrolls a device (as SYSTEM) with a random key hash and returns its id. */
export async function createDevice(client: pg.Client, fixture: DeviceFixture): Promise<bigint> {
  return inContext(client, async () => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO auth.devices (code, name, device_kind, branch_id, key_hash, key_expires_at, enrolled_by)
       SELECT $1, 'Test PC', $2, b.id, sha256(gen_random_uuid()::text::bytea),
              now() + make_interval(days => $3::integer), 1
         FROM sys.branches AS b ORDER BY b.id LIMIT 1
       RETURNING id`,
      [fixture.code, fixture.kind ?? 'office', fixture.keyDays ?? 365],
    );
    return BigInt(rows[0]!.id);
  });
}
