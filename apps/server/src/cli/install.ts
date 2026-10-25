/**
 * `artepool-svc run install` — the installation of the server PC (M6.2 part F), started once by
 * the server setup as administrator; the steps are in install/steps.ts. Progress lines go to the
 * standard output (the setup shows them) and to the install log in `logs\install`.
 */
import { join } from 'node:path';
import { loadEnv } from '@artepool/node-kit';
import { exec } from './restore-from-backup';
import { waitHealthy } from './install/health';
import { InstallLog, logFileName } from './install/log';
import { InstallError, runInstall, windowsBuildOf, type InstallPaths } from './install/steps';
import { windowsPlatform } from './install/windows';

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new InstallError(`${name} is not set: the installation is started by artepool-svc.`);
  return value;
}

loadEnv();
let log: InstallLog | null = null;
try {
  const dataDir = required('ARTEPOOL_DATA_DIR');
  const logs = required('ARTEPOOL_LOG_DIR');
  log = new InstallLog(join(logs, 'install', logFileName('install')));
  const secrets = join(dataDir, 'secrets');
  const paths: InstallPaths = {
    dataDir,
    pgBin: required('ARTEPOOL_PG_BIN'),
    pgdata: join(dataDir, 'pgdata'),
    wal: join(dataDir, 'wal'),
    backups: required('ARTEPOOL_BACKUP_DIR'),
    logs,
    secrets,
    config: join(dataDir, 'config'),
    setup: join(dataDir, 'setup'),
    tls: required('ARTEPOOL_TLS_DIR'),
    tokenFile: required('ARTEPOOL_SETUP_TOKEN_FILE'),
  };
  const serverPort = Number(required('SERVER_PORT'));
  await runInstall({
    paths,
    serverPort,
    databasePort: Number(process.env.PGPORT || 5432),
    databaseName: required('ARTEPOOL_DB'),
    platform: windowsPlatform({
      exec,
      programDir: required('ARTEPOOL_PROGRAM_DIR'),
      pgBin: paths.pgBin,
      logDir: logs,
    }),
    exec,
    log,
    windowsBuild: windowsBuildOf(),
    waitHealthy: waitHealthy(
      serverPort,
      () => new InstallError('The server did not answer within two minutes; see logs\\server.'),
    ),
  });
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  if (log) log.line(`FAILED: ${reason}`);
  else console.error(`FAILED: ${reason}`);
  process.exitCode = 1;
}
