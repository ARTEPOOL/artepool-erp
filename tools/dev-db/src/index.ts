/** Database roles and databases: development setup, and the installed server's installation program. */
import type { Client } from 'pg';
import { assertDevOrTestDatabase, ROLES, rolePasswords } from '@artepool/node-kit';

export const MIN_SERVER_VERSION = 180000;

export async function assertServerVersion(admin: Client): Promise<void> {
  const { rows } = await admin.query<{ v: string }>(
    `SELECT current_setting('server_version_num') AS v`,
  );
  const version = Number.parseInt(rows[0]?.v ?? '0', 10);
  if (version < MIN_SERVER_VERSION) {
    throw new Error(`PostgreSQL 18 or newer is required (this server is ${version}).`);
  }
}

async function roleExists(admin: Client, name: string): Promise<boolean> {
  const { rowCount } = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  return (rowCount ?? 0) > 0;
}

/** Creates the ARTÉPOOL roles if missing and sets their passwords from the environment. Safe to run again. */
export async function ensureRoles(admin: Client): Promise<void> {
  const passwords = rolePasswords();
  const login: [string, string, string][] = [
    [ROLES.migrator, passwords.migrator, 'LOGIN'],
    [ROLES.api, passwords.api, 'LOGIN'],
    // CREATEDB: the restore test restores into its own throwaway database (decision 0086).
    [ROLES.backup, passwords.backup, 'LOGIN REPLICATION CREATEDB'],
    [ROLES.maint, passwords.maint, 'LOGIN'],
  ];
  if (!(await roleExists(admin, ROLES.owner))) {
    await admin.query(`CREATE ROLE ${ROLES.owner} NOLOGIN`);
  }
  for (const [name, password, options] of login) {
    const verb = (await roleExists(admin, name)) ? 'ALTER' : 'CREATE';
    await admin.query(`${verb} ROLE ${name} ${options} PASSWORD ${admin.escapeLiteral(password)}`);
  }
  await admin.query(`GRANT ${ROLES.owner} TO ${ROLES.migrator}`);
  await admin.query(`GRANT pg_read_all_data TO ${ROLES.backup}`);
}

export async function databaseExists(admin: Client, name: string): Promise<boolean> {
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  return (rowCount ?? 0) > 0;
}

/**
 * Creates an empty ARTÉPOOL database owned by artepool_owner, or a copy of `template`.
 * Uses PostgreSQL's built-in C.UTF-8 locale so behaviour is identical on Windows and Linux.
 * Development and test databases only (names ending in _dev or _test).
 */
export async function createDatabase(
  admin: Client,
  name: string,
  template?: string,
): Promise<void> {
  assertDevOrTestDatabase(name);
  await createAppDatabase(admin, name, template);
}

/**
 * The same for the installed server (M6.2 part F): only the installation program calls it, once,
 * on a fresh PostgreSQL that holds no ARTÉPOOL database yet.
 */
export async function createAppDatabase(
  admin: Client,
  name: string,
  template?: string,
): Promise<void> {
  const source = template
    ? `TEMPLATE ${admin.escapeIdentifier(template)}`
    : `TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'`;
  const db = admin.escapeIdentifier(name);
  await admin.query(`CREATE DATABASE ${db} OWNER ${ROLES.owner} ${source}`);
  await admin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`);
  await admin.query(
    `GRANT CONNECT ON DATABASE ${db} TO ${ROLES.migrator}, ${ROLES.api}, ${ROLES.backup}, ${ROLES.maint}`,
  );
}

export async function dropDatabase(admin: Client, name: string): Promise<void> {
  assertDevOrTestDatabase(name);
  await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
}
