/** Node-only helpers shared by the tools, the tests and the server: paths, .env, DB connections. */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Absolute path of the repository root. */
export const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

export const migrationsDir = join(repoRoot, 'db', 'migrations');

/** Loads `.env` from the repository root if present. Variables already set are kept (CI sets its own). */
export function loadEnv(): void {
  const file = join(repoRoot, '.env');
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing setting ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

/** The ARTÉPOOL database roles (docs/database-schema.md §2). */
export const ROLES = {
  owner: 'artepool_owner',
  migrator: 'artepool_migrator',
  api: 'artepool_api',
  backup: 'artepool_backup',
  maint: 'artepool_maint',
} as const;

export type LoginRole = 'superuser' | 'migrator' | 'api' | 'backup' | 'maint';

const PASSWORD_SETTING: Record<Exclude<LoginRole, 'superuser'>, string> = {
  migrator: 'ARTEPOOL_MIGRATOR_PASSWORD',
  api: 'ARTEPOOL_API_PASSWORD',
  backup: 'ARTEPOOL_BACKUP_PASSWORD',
  maint: 'ARTEPOOL_MAINT_PASSWORD',
};

export interface PgConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  application_name?: string;
}

/** Connection settings for one login role. `database` defaults to ARTEPOOL_DB (or `postgres` for the superuser). */
export function connectionFor(role: LoginRole, database?: string): PgConnection {
  const host = process.env.PGHOST || 'localhost';
  const port = Number.parseInt(process.env.PGPORT || '5432', 10);
  if (role === 'superuser') {
    return {
      host,
      port,
      user: process.env.PG_SUPERUSER || 'postgres',
      password: process.env.PG_SUPERUSER_PASSWORD ?? '',
      database: database ?? 'postgres',
    };
  }
  return {
    host,
    port,
    user: ROLES[role],
    password: requireEnv(PASSWORD_SETTING[role]),
    database: database ?? requireEnv('ARTEPOOL_DB'),
  };
}

/** Passwords for the login roles, read from the environment. */
export function rolePasswords(): Record<Exclude<LoginRole, 'superuser'>, string> {
  return {
    migrator: requireEnv(PASSWORD_SETTING.migrator),
    api: requireEnv(PASSWORD_SETTING.api),
    backup: requireEnv(PASSWORD_SETTING.backup),
    maint: requireEnv(PASSWORD_SETTING.maint),
  };
}

const SAFE_DB_NAME = /^[a-z][a-z0-9_]*_(dev|test)(_[a-z0-9]+)*$/;

/**
 * Development tools may only create, drop or tamper with databases whose names mark them as
 * development or test databases (…_dev, …_test, …_test_xyz). Real data is never touched.
 */
export function assertDevOrTestDatabase(name: string): void {
  if (!SAFE_DB_NAME.test(name)) {
    throw new Error(
      `Refusing to touch database "${name}": development tools only work on databases ending in _dev or _test.`,
    );
  }
}

export { SecretBox, SecretBoxError } from './secret-box';
