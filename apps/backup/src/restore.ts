/**
 * The restore test (decision 0086): the newest local copy is restored into a throwaway database,
 * every integrity check runs on it, the result is recorded, and the throwaway database is
 * removed. It proves the copy can bring the business back, not only that a file exists.
 */
import { basename } from 'node:path';
import pg from 'pg';
import type { BackupConfig } from './config';
import { allOk, recordIntegrityRun, runChecks, type CheckResults } from './integrity';
import { latestLocalCopy, localBackup } from './local';
import { failRun, finishRun, startRun } from './runs';
import { connectionArgs, pgTool, run } from './tools';

/**
 * Removes the throwaway database, without `WITH (FORCE)`: for a role that is not a superuser,
 * FORCE fails when autovacuum is working in that database ("permission denied to terminate
 * process", common right after a large restore). A plain DROP stops autovacuum itself and waits
 * for it. If one of this role's own sessions is still connected (55006, object in use), it is
 * ended (a role may end its own sessions) and the plain DROP tried again.
 */
export async function dropThrowaway(admin: pg.Client, database: string): Promise<void> {
  const name = admin.escapeIdentifier(database);
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== '55006' || attempt >= 5) throw error;
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND usename = current_user AND pid <> pg_backend_pid()`,
        [database],
      );
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

export function restoreDatabaseName(live: string): string {
  return `${live.slice(0, 63 - '_restore_test'.length)}_restore_test`;
}

export interface RestoreTestResult {
  runId: string;
  ok: boolean;
  fileName: string;
  results: CheckResults;
}

export async function restoreTest(
  live: pg.Client,
  config: BackupConfig,
  options: { requestId?: string | null } = {},
): Promise<RestoreTestResult> {
  const target = restoreDatabaseName(config.connection.database);
  const runId = await startRun(live, 'restore_test', { requestId: options.requestId, target });
  const admin = new pg.Client({
    ...config.connection,
    database: 'postgres',
    application_name: 'artepool-backup-restore',
  });
  let created = false;
  try {
    const copy = (await latestLocalCopy(config)) ?? (await localBackup(live, config)).path;
    await admin.connect();
    const name = admin.escapeIdentifier(target);
    await dropThrowaway(admin, target);
    await admin.query(
      `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'`,
    );
    created = true;
    // Nobody else may connect to the copy while it exists.
    await admin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${name} FROM PUBLIC`);
    await run(
      pgTool(config.pgBin, 'pg_restore'),
      [
        ...connectionArgs(config.connection, target),
        '--no-owner',
        '--no-privileges',
        '--exit-on-error',
        copy,
      ],
      config.connection,
    );
    const restored = new pg.Client({ ...config.connection, database: target });
    await restored.connect();
    let results: CheckResults;
    try {
      results = await runChecks(restored);
    } finally {
      await restored.end();
    }
    const ok = allOk(results);
    await recordIntegrityRun(
      live,
      { kind: 'restore_test', database: target, backupRunId: runId },
      results,
    );
    const fileName = basename(copy);
    if (ok) {
      await finishRun(live, runId, { fileName, details: { checks: Object.keys(results).length } });
    } else {
      const failed = Object.entries(results)
        .filter(([, r]) => !r.ok)
        .map(([k]) => k);
      await failRun(
        live,
        runId,
        new Error(`integrity checks found problems: ${failed.join(', ')}`),
      );
    }
    return { runId, ok, fileName, results };
  } catch (error) {
    await failRun(live, runId, error);
    throw error;
  } finally {
    if (created) await dropThrowaway(admin, target);
    await admin.end().catch(() => undefined);
  }
}
