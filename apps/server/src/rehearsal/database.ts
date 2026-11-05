/**
 * The rehearsal's own database (M7, decision 0119): `artepool_rehearsal_<run>`, created empty,
 * migrated like a new installation, marked in its comment with the run's random token and the
 * number of the process running it, and dropped at the end. Nothing here can touch any other
 * database: the name and the mark are both checked before a drop, and a rehearsal never writes to
 * the live database except its own run row (written by the caller). A rehearsal database is left
 * over only when the process in its mark is no longer running (a power cut, a closed program):
 * rehearsals running at the same time (the tests, a busy day beside them) never drop each other's.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createAppDatabase } from '@artepool/dev-db';
import { migrate } from '@artepool/migrate';
import { connectionFor, migrationsDir } from '@artepool/node-kit';

export const REHEARSAL_PREFIX = 'artepool_rehearsal_';
const NAME = /^artepool_rehearsal_[0-9a-f]{12}$/;
const MARK = (token: string, pid = process.pid) => `ARTEPOOL rehearsal ${token} ${pid}`;
const MARK_SHAPE = /^ARTEPOOL rehearsal ([0-9a-f]{32}) ([1-9][0-9]*)$/;

/** Is this process still running on this PC? */
export function processRunning(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

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
 * Drops a rehearsal database: only when its name has the rehearsal's shape and its comment is the
 * rehearsal's mark with this run's token (or, for a left-over one, any rehearsal's mark whose
 * process no longer runs). Anything else is refused.
 */
export async function dropRehearsalDatabase(
  name: string,
  token: string | { leftover: true },
): Promise<void> {
  if (!isRehearsalName(name))
    throw new Error(`Refusing to drop "${name}": not a rehearsal database`);
  const admin = await superuser();
  try {
    const { rows } = await admin.query<{ mark: string | null }>(
      `SELECT shobj_description(oid, 'pg_database') AS mark FROM pg_database WHERE datname = $1`,
      [name],
    );
    if (rows.length === 0) return;
    const mark = MARK_SHAPE.exec(rows[0]!.mark ?? '');
    if (!mark)
      throw new Error(`Refusing to drop "${name}": it does not carry the rehearsal's mark`);
    if (typeof token === 'string' ? mark[1] !== token : processRunning(Number(mark[2])))
      throw new Error(`Refusing to drop "${name}": it carries another run's mark`);
    await admin.query(`DROP DATABASE ${admin.escapeIdentifier(name)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** The throwaway copy the rehearsal's restore test makes of a rehearsal database. */
const RESTORED = /^artepool_rehearsal_[0-9a-f]{12}_restore_test$/;

/**
 * Rehearsal databases left behind by a run that stopped half way (its process no longer runs):
 * dropped, with the restored copy its restore test was making (named after it; the restore test
 * drops it itself when it is not cut off). Databases of rehearsals still running stay.
 */
export async function dropLeftoverRehearsals(): Promise<string[]> {
  const admin = await superuser();
  const dropped: string[] = [];
  try {
    const { rows } = await admin.query<{ datname: string; mark: string | null }>(
      `SELECT datname, shobj_description(oid, 'pg_database') AS mark
         FROM pg_database WHERE datname LIKE 'artepool\\_rehearsal\\_%'`,
    );
    const marks = new Map(rows.map((r) => [r.datname, MARK_SHAPE.exec(r.mark ?? '')]));
    const leftover = (name: string) => {
      const mark = marks.get(name);
      return !!mark && !processRunning(Number(mark[2]));
    };
    for (const { datname } of rows) {
      const base = datname.replace(/_restore_test$/, '');
      if (RESTORED.test(datname) && (!marks.has(base) || leftover(base))) {
        await admin.query(`DROP DATABASE ${admin.escapeIdentifier(datname)} WITH (FORCE)`);
        dropped.push(datname);
      }
    }
    for (const { datname } of rows) {
      if (isRehearsalName(datname) && leftover(datname)) {
        await dropRehearsalDatabase(datname, { leftover: true });
        dropped.push(datname);
      }
    }
  } finally {
    await admin.end();
  }
  return dropped;
}

/** The mark a rehearsal database carries (exported for the tests of a left-over database). */
export const rehearsalMark = MARK;
