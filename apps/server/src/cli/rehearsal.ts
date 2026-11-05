/**
 * `artepool-svc run rehearsal <run>` — the automated rehearsal the owner started from System health
 * (M7 part B, decision 0119). Started by the server PC's updater, at low priority, once it has taken
 * the request. It plays the shop's day on its own throwaway database (created and dropped with the
 * superuser, as the restore program does), and writes each step and the result to the run's row.
 * Its lines go to `logs\install\rehearsal.log` (no secret is ever written).
 */
import { join } from 'node:path';
import pg from 'pg';
import { connectionFor, loadEnv } from '@artepool/node-kit';
import { InstallLog } from './install/log';
import { runShopRehearsal } from '../rehearsal/shop';

loadEnv();
const id = process.argv[2] ?? '';
const logDir = process.env.ARTEPOOL_LOG_DIR;
const log = logDir
  ? new InstallLog(join(logDir, 'install', 'rehearsal.log'), () => undefined)
  : { line: (text: string) => console.log(text) };

if (!/^[1-9][0-9]{0,17}$/.test(id)) {
  console.error('Usage: rehearsal <run id> (started by the updater after the owner asks for it)');
  process.exit(2);
}

const live = new pg.Client({ ...connectionFor('backup'), application_name: 'artepool-rehearsal' });
try {
  await live.connect();
  log.line(`Rehearsal ${id}: started.`);
  const dataDir = process.env.ARTEPOOL_DATA_DIR;
  const report = await runShopRehearsal(
    live,
    id,
    dataDir ? { workDir: join(dataDir, 'rehearsal') } : {},
  );
  const red = report.steps.find((s) => !s.ok);
  log.line(
    report.ok
      ? `Rehearsal ${id}: green.`
      : `Rehearsal ${id}: red at ${red?.step ?? '?'}${red?.detail ? ` (${red.detail})` : ''}.`,
  );
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  log.line(`Rehearsal ${id} FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await live.end().catch(() => undefined);
}
