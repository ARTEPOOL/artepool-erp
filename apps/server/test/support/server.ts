/** A real API server on a throwaway test database, with logs captured for inspection. */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import type pg from 'pg';
import { connectionFor } from '@artepool/node-kit';
import { createTestDatabase, type TestDatabase } from '@artepool/testing';
import { buildApp } from '../../src/app';
import { SecretHasher } from '../../src/platform/crypto/hashing';
import { SecretBox } from '../../src/platform/crypto/secret-box';
import { newToken, sha256 } from '../../src/platform/crypto/tokens';
import { createDb, createPool, type Db } from '../../src/platform/db/pool';
import { stamped } from '../../src/platform/db/stamped';
import { withBusinessTx } from '../../src/platform/db/tx';
import { createDeps, type AppDeps } from '../../src/platform/http/deps';

/**
 * Tests hash with a small Argon2id cost to stay fast. Production always uses ARGON2_PARAMS
 * (checked by a unit test); this cheaper cost is only ever constructed here.
 */
export const TEST_ARGON2 = { memoryCost: 1024, timeCost: 1, parallelism: 1 } as const;

export const CLIENT_VERSION = '0.1.0';

export interface TestServer {
  app: FastifyInstance;
  db: Db;
  deps: AppDeps;
  testDb: TestDatabase;
  /** Every log line written by the server, as raw JSON text. */
  logs: string[];
  /** Superuser connection, only to simulate time passing. */
  admin: pg.Client;
  close(): Promise<void>;
}

export async function startTestServer(
  register?: (app: FastifyInstance) => void,
): Promise<TestServer> {
  const testDb = await createTestDatabase();
  const db = createDb(createPool(connectionFor('api', testDb.name), 5));
  const logs: string[] = [];
  const deps = createDeps({
    db,
    secretBox: SecretBox.fromKey(Buffer.alloc(32, 42)),
    hasher: new SecretHasher(TEST_ARGON2),
  });
  const app = buildApp({ logLevel: 'info', logStream: { write: (line) => logs.push(line) } }, deps);
  register?.(app);
  await app.ready();
  const admin = await testDb.connect('superuser');
  return {
    app,
    db,
    deps,
    testDb,
    logs,
    admin,
    async close() {
      await app.close();
      await db.destroy();
      await testDb.drop();
    },
  };
}

const asSystem = () => ({ userId: 1n, requestId: randomUUID(), reason: 'test fixture' });

export interface TestDevice {
  id: bigint;
  key: string;
}

export async function addDevice(
  server: TestServer,
  options: { code: string; kind?: 'pos' | 'office' | 'warehouse' | 'server' },
): Promise<TestDevice> {
  const key = newToken();
  const id = await withBusinessTx(server.db, asSystem(), async (trx) => {
    const branch = await trx
      .selectFrom('sys.branches')
      .select('id')
      .orderBy('id')
      .executeTakeFirstOrThrow();
    const row = await trx
      .insertInto('auth.devices')
      .values(
        stamped('auth.devices', {
          code: options.code,
          name: 'Test PC',
          device_kind: options.kind ?? 'office',
          branch_id: branch.id,
          key_hash: sha256(key),
          key_expires_at: sql<Date>`now() + interval '365 days'`,
          enrolled_by: 1n,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
  return { id, key };
}

export interface UserOptions {
  username: string;
  method?: 'pin' | 'password' | 'password_totp';
  roles?: string[];
  password?: string;
  pin?: string;
  mustChange?: boolean;
}

export async function addUser(server: TestServer, options: UserOptions): Promise<bigint> {
  const method = options.method ?? 'password';
  const password =
    method === 'pin' ? null : await server.deps.hasher.hash(options.password ?? 'pool-water-blue');
  const pin =
    method === 'pin' || options.pin ? await server.deps.hasher.hash(options.pin ?? '4829') : null;
  return withBusinessTx(server.db, asSystem(), async (trx) => {
    const row = await trx
      .insertInto('auth.users')
      .values(
        stamped('auth.users', {
          username: options.username,
          display_name_ar: 'مستخدم',
          display_name_en: 'User',
          sign_in_method: method,
          password_hash: password,
          pin_hash: pin,
          must_change_password: options.mustChange ?? false,
          pin_must_change: method === 'pin' ? (options.mustChange ?? false) : false,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const role of options.roles ?? []) {
      await sql`INSERT INTO auth.user_roles (user_id, role_id)
                SELECT ${row.id}, id FROM auth.roles WHERE code = ${role}`.execute(trx);
    }
    return row.id;
  });
}

/** A session row with a known token, as the sign-in API will create (T4). */
export async function openSession(
  server: TestServer,
  options: {
    userId: bigint;
    deviceId: bigint;
    method?: 'password' | 'password_totp' | 'recovery_code' | 'pin';
    stage?: 'second_factor' | 'full';
    idleSeconds?: number;
  },
): Promise<{ id: bigint; token: string }> {
  const token = newToken();
  const row = await server.db
    .insertInto('auth.sessions')
    .values({
      token_hash: sha256(token),
      user_id: options.userId,
      device_id: options.deviceId,
      stage: options.stage ?? 'full',
      auth_method: options.method ?? 'password',
      idle_timeout_sec: options.idleSeconds ?? 900,
      expires_at: sql<Date>`now() + interval '12 hours'`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, token };
}

export interface CallOptions {
  device?: TestDevice | string | null;
  token?: string | null;
  version?: string | null;
  idempotencyKey?: string;
  background?: boolean;
  remoteAddress?: string;
  body?: unknown;
}

/** Sends a request the way the desktop app does: device key, app version, session token. */
export function call(
  server: TestServer,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  options: CallOptions = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {};
  const device = typeof options.device === 'string' ? options.device : options.device?.key;
  if (device) headers['x-artepool-device'] = device;
  if (options.version !== null) headers['x-artepool-client'] = options.version ?? CLIENT_VERSION;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.background) headers['x-artepool-background'] = '1';
  const request: InjectOptions = {
    method,
    url,
    headers,
    ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
    ...(options.body !== undefined ? { payload: options.body as InjectOptions['payload'] } : {}),
  };
  return server.app.inject(request);
}

/** The error code of a failed response. */
export const errorCode = (response: LightMyRequestResponse): string | undefined =>
  response.json<{ error?: { code?: string } }>().error?.code;

/** Moves a row's clock back as if time had passed (triggers bypassed for this only). */
export async function ageRow(
  server: TestServer,
  statement: string,
  params: unknown[],
): Promise<void> {
  await server.admin.query('BEGIN');
  await server.admin.query('SET LOCAL session_replication_role = replica');
  await server.admin.query(statement, params);
  await server.admin.query('COMMIT');
}
