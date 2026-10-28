/**
 * `artepool-svc run upgrade prepare --from <x.y.z> --to <x.y.z>` and `artepool-svc run upgrade
 * apply` — the two phases of an upgrade of the server PC (decision 0103, M6.2 part G2), started
 * by the server setup as administrator; the steps are in upgrade/steps.ts.
 *
 * `prepare` writes `updates\pending-upgrade.json` (versions and the pre-upgrade copy) for `apply`;
 * `apply` writes `updates\last-result.json`, which System health shows. Progress lines go to the
 * standard output and to `logs\install\upgrade-<time>.log`; the last line is the JSON result.
 * A failure also leaves `updates\last-failure.txt` (the step, then why, one line each), which the
 * setup copies into its own log and shows in its message.
 * Exit code 0: done; 1: failed (after `prepare`, nothing changed and the services run again; after
 * `apply`, every service is stopped so the setup can put the previous programs back).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { connectionFor, loadEnv, migrationsDir } from '@artepool/node-kit';
import { TLS_FILES } from '@artepool/tls';
import { exec } from './restore-from-backup';
import { waitHealthy } from './install/health';
import { InstallLog, logFileName } from './install/log';
import { windowsPlatform } from './install/windows';
import {
  applyUpgrade,
  failureText,
  postgresMajor,
  prepareUpgrade,
  UpgradeError,
  type UpgradeResult,
} from './upgrade/steps';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: the upgrade is started by artepool-svc.`);
  return value;
}

interface Pending {
  from: string;
  to: string;
  backup: string;
  sha256: string;
}

const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

loadEnv();
const phase = process.argv[2];
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: { from: { type: 'string' }, to: { type: 'string' } },
});
let log: InstallLog | null = null;
const dataDir = process.env.ARTEPOOL_DATA_DIR ?? '';
const updatesDir = join(dataDir, 'updates');
const pendingFile = join(updatesDir, 'pending-upgrade.json');
const resultFile = join(updatesDir, 'last-result.json');
const failureFile = join(updatesDir, 'last-failure.txt');
const saveResult = (result: UpgradeResult) => {
  mkdirSync(updatesDir, { recursive: true });
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
};
const saveFailure = (step: string, detail: string) => {
  try {
    mkdirSync(updatesDir, { recursive: true });
    writeFileSync(failureFile, failureText(step, detail));
  } catch {
    // The reason stays in this program's own log.
  }
};
if (dataDir) rmSync(failureFile, { force: true });

try {
  required('ARTEPOOL_DATA_DIR');
  const logs = required('ARTEPOOL_LOG_DIR');
  log = new InstallLog(join(logs, 'install', logFileName('upgrade')));
  const programDir = required('ARTEPOOL_PROGRAM_DIR');
  const pgBin = required('ARTEPOOL_PG_BIN');
  const databaseName = required('ARTEPOOL_DB');
  const platform = windowsPlatform({ exec, programDir, pgBin, logDir: logs });
  const connections = {
    backup: connectionFor('backup'),
    migrator: connectionFor('migrator'),
    superuser: connectionFor('superuser'),
  };

  if (phase === 'prepare') {
    const from = values.from;
    const to = values.to;
    if (!from || !to) throw new Error('Use: upgrade prepare --from <x.y.z> --to <x.y.z>');
    const dataPgMajor = Number(readFileSync(join(dataDir, 'pgdata', 'PG_VERSION'), 'utf8').trim());
    // The PostgreSQL this new version brings, in its own (new) program folder.
    const exe = process.platform === 'win32' ? 'postgres.exe' : 'postgres';
    let bundled: number | null = null;
    try {
      bundled = postgresMajor(
        execFileSync(join(programDir, 'pgsql', 'bin', exe), ['--version'], {
          encoding: 'utf8',
          windowsHide: true,
        }),
      );
    } catch {
      bundled = null;
    }
    try {
      const prepared = await prepareUpgrade({
        from,
        to,
        dataPgMajor,
        bundledPgMajor: bundled,
        databaseName,
        migrationsDir,
        backupsDir: required('ARTEPOOL_BACKUP_DIR'),
        pgBin,
        connections,
        platform,
        log,
      });
      mkdirSync(updatesDir, { recursive: true });
      const pending: Pending = { from, to, ...prepared };
      writeFileSync(pendingFile, `${JSON.stringify(pending, null, 2)}\n`);
      print({ result: { ok: true, ...pending } });
    } catch (error) {
      const step = error instanceof UpgradeError ? error.step : 'checks';
      const detail = error instanceof Error ? error.message : String(error);
      log.line(`FAILED (${step}): ${detail}`);
      saveFailure(step, detail);
      const result: UpgradeResult = {
        ok: false,
        from,
        to,
        at: new Date().toISOString(),
        backup: null,
        step,
        detail,
        databasePutBack: false,
      };
      saveResult(result);
      print({ result });
      process.exitCode = 1;
    }
  } else if (phase === 'apply') {
    const pending = JSON.parse(readFileSync(pendingFile, 'utf8')) as Pending;
    const serverPort = Number(required('SERVER_PORT'));
    const result = await applyUpgrade({
      from: pending.from,
      to: pending.to,
      backup: pending.backup,
      databaseName,
      migrationsDir,
      pgBin,
      tlsCaFile: join(required('ARTEPOOL_TLS_DIR'), TLS_FILES.caCert),
      connections,
      platform,
      log,
      waitHealthy: waitHealthy(
        serverPort,
        () => new Error('The new version did not answer within two minutes; see logs\\server.'),
      ),
    });
    saveResult(result);
    if (!result.ok) saveFailure(result.step, result.detail);
    print({ result });
    process.exitCode = result.ok ? 0 : 1;
  } else {
    throw new Error('Use: upgrade prepare --from <x.y.z> --to <x.y.z> | upgrade apply');
  }
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  if (log) log.line(`FAILED: ${reason}`);
  else console.error(`FAILED: ${reason}`);
  saveFailure('checks', reason);
  print({ result: { ok: false, step: 'checks', detail: reason } });
  process.exitCode = 1;
}
