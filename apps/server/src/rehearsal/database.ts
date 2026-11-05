/**
 * The rehearsal's own database (M7, decision 0119): `artepool_rehearsal_<run>`, created empty,
 * migrated like a new installation, marked with the run's random token in its comment, and
 * dropped at the end. Nothing here can touch any other database: the name and the mark are both
 * checked before a drop, and a rehearsal never writes to the live database except its own run
 * row (written by the caller).
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createAppDatabase } from '@artepool/dev-db';
import { migrate } from '@artepool/migrate';
import { connectionFor, migrationsDir } from '@artepool/node-kit';

export const REHEARSAL_PREFIX = 'artepool_rehearsal_';
const NAME = /^artepool_rehearsal_[0-9a-f]{12}$/;
const MARK = (token: string) => `ARTEPOOL rehearsal ${token}`;

export interface RehearsalDatabase {
  name: string;
  token: string;
}

async function superuser(): Promise<pg.Client> {
  const admin = new pg.Client({
    ...connectionFor('superuser'),
    database: 'postgres',
    application_name: 'artepool-rehearsal',
  });
  await admin.connect();
  return admin;
}

/** True only for a database this module made: the name's shape and its own mark. */
export function isRehearsalName(name: string): boolean {
  return NAME.test(name);
}

/** Creates and migrates a new rehearsal database. */
export async function createRehearsalDatabase(): Promise<RehearsalDatabase> {
  const name = `${REHEARSAL_PREFIX}${randomBytes(6).toString('hex')}`;
  const token = randomBytes(16).toString('hex');
  const admin = await superuser();
  try {
    await createAppDatabase(admin, name);
    await admin.query(
      `COMMENT ON DATABASE ${admin.escapeIdentifier(name)} IS ${admin.escapeLiteral(MARK(token))}`,
    );
  } finally {
    await admin.end();
  }
  const migrator = new pg.Client({
    ...connectionFor('migrator', name),
    application_name: 'artepool-rehearsal',
  });
  await migrator.connect();
  try {
    await migrate({ client: migrator, dir: migrationsDir, allOrNothing: true });
  } finally {
    await migrator.end();
  }
  return { name, token };
}

/**
 * Drops a rehearsal database: only when its name has the rehearsal's shape and its comment is
 * the rehearsal's mark (with this run's token, when given). Anything else is refused.
 */
export async function dropRehearsalDatabase(name: string, token?: string): Promise<void> {
  if (!isRehearsalName(name))
    throw new Error(`Refusing to drop "${name}": not a rehearsal database`);
  const admin = await superuser();
  try {
    const { rows } = await admin.query<{ mark: string | null }>(
      `SELECT shobj_description(oid, 'pg_database') AS mark FROM pg_database WHERE datname = $1`,
      [name],
    );
    if (rows.length === 0) return;
    const mark = rows[0]!.mark ?? '';
    const ok = token ? mark === MARK(token) : mark.startsWith('ARTEPOOL rehearsal ');
    if (!ok) throw new Error(`Refusing to drop "${name}": it does not carry the rehearsal's mark`);
    await admin.query(`DROP DATABASE ${admin.escapeIdentifier(name)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** Rehearsal databases left behind by a run that stopped half way (a power cut): dropped. */
export async function dropLeftoverRehearsals(): Promise<string[]> {
  const admin = await superuser();
  let names: string[];
  try {
    const { rows } = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'artepool\\_rehearsal\\_%'`,
    );
    names = rows.map((r) => r.datname).filter(isRehearsalName);
  } finally {
    await admin.end();
  }
  for (const name of names) await dropRehearsalDatabase(name);
  return names;
}
