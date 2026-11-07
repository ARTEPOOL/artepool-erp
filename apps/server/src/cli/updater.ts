/**
 * `artepool-svc run updater` — the server PC's updater (decision 0108, M6.2 part G5), run every
 * minute as SYSTEM by the scheduled task "ARTEPOOL Updater", and at once when the server wakes it
 * (decision 0115); the steps are in
 * updater/steps.ts. It also renews the server certificate 60 days before it ends
 * (updater/certificate.ts, M6.2 part H3), and checks the cashier's Windows account once an hour
 * (updater/cashier-account.ts, M6.4). Its lines go to `logs\install\updater.log`, only when
 * the outcome changes (no secret is ever written).
 */
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { LATEST_URL } from '@artepool/release';
import { childEnv, connectionFor, loadEnv, resourcePath } from '@artepool/node-kit';
import { waitHealthy } from './install/health';
import { InstallLog } from './install/log';
import { windowsPlatform } from './install/windows';
import { exec } from './restore-from-backup';
import { recordCashierAccount } from './updater/cashier-account';
import { renewServerCertificate } from './updater/certificate';
import { resumableDownload } from './updater/download';
import { outcomeChanged, runUpdater } from './updater/steps';
import { claimRehearsal } from '../rehearsal/shop';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: the updater is started by artepool-svc.`);
  return value;
}

async function fetchOk(url: string, timeoutMs: number): Promise<Response> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

loadEnv();
const log = new InstallLog(
  join(required('ARTEPOOL_LOG_DIR'), 'install', 'updater.log'),
  () => undefined,
);
const dataDir = required('ARTEPOOL_DATA_DIR');
const programDir = required('ARTEPOOL_PROGRAM_DIR');
const updatesDir = join(dataDir, 'updates');
mkdirSync(updatesDir, { recursive: true });
const client = new pg.Client({ ...connectionFor('backup'), application_name: 'artepool-updater' });
try {
  await client.connect();
  const manifest = JSON.parse(
    readFileSync(join(programDir, 'server', 'manifest.json'), 'utf8'),
  ) as {
    version: string;
  };
  const outcome = await runUpdater({
    db: client,
    currentVersion: manifest.version,
    publicKey: readFileSync(resourcePath('release', 'update-public-key.txt'), 'utf8'),
    updatesDir,
    fetchLatest: async () => (await fetchOk(LATEST_URL, 30_000)).json(),
    // Continues a part already received after a cut (0115); an hour at most per try.
    download: (url, to, onProgress) =>
      resumableDownload(url, to, { timeoutMs: 60 * 60 * 1000, onProgress }),
    // The runtime installed beside the programs (0115); none before 0.9.0: the full setup then.
    installedRuntime: async () => {
      try {
        const { id } = JSON.parse(await readFile(join(programDir, 'runtime.json'), 'utf8')) as {
          id?: unknown;
        };
        return typeof id === 'string' && /^[0-9a-f]{12}$/.test(id) ? id : null;
      } catch {
        return null;
      }
    },
    // Windows' own tar (bsdtar reads zip files), by its full path; the names were checked first.
    unzip: async (zip, to) => {
      const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      await promisify(execFile)(tar, ['-xf', zip, '-C', to], {
        windowsHide: true,
        timeout: 10 * 60 * 1000,
        env: childEnv({}),
      });
    },
    runSetup: (file, runtimeDir) => {
      // Detached: the setup replaces this program's folder, so the updater ends first.
      const args = ['/S', ...(runtimeDir ? [`/RUNTIME=${runtimeDir}`] : [])];
      // Never with this program's secrets: the setup asks the launcher for what it needs.
      spawn(file, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: childEnv({}),
      }).unref();
    },
    now: () => new Date(),
    log: (line) => log.line(line),
  });
  if (await outcomeChanged(updatesDir, outcome)) log.line(`Updater: ${outcome}.`);

  // The server certificate renews itself 60 days before it ends (M6.2 part H3); never while an
  // update is starting or running (both restart the server).
  if (outcome !== 'started' && outcome !== 'installing') {
    const platform = windowsPlatform({
      exec,
      programDir,
      pgBin: required('ARTEPOOL_PG_BIN'),
      logDir: required('ARTEPOOL_LOG_DIR'),
    });
    const renewal = await renewServerCertificate({
      db: client,
      tlsDir: required('ARTEPOOL_TLS_DIR'),
      now: () => new Date(),
      restartServer: async () => {
        await platform.stopService('server');
        await platform.startService('server');
      },
      waitHealthy: waitHealthy(
        Number(required('SERVER_PORT')),
        () => new Error('The server did not answer within two minutes; see logs\\server.'),
      ),
      log: (line) => log.line(line),
    });
    if (renewal === 'renewed' || renewal === 'failed') log.line(`Certificate: ${renewal}.`);

    // The cashier's Windows account (M6.4): checked once an hour, as SYSTEM (the LSA secret).
    const cashier = await recordCashierAccount({
      db: client,
      runCheck: async () =>
        (
          await promisify(execFile)(
            join(programDir, 'artepool-svc.exe'),
            ['--data', dataDir, 'cashier-account', 'check'],
            { windowsHide: true, timeout: 60_000, env: childEnv({}) },
          )
        ).stdout,
      now: () => new Date(),
    });
    if (cashier === 'changed' || cashier === 'failed') log.line(`Cashier account: ${cashier}.`);

    // The owner's «ابدأ البروفة» (M7, decision 0119): its own program, at low priority, so the
    // shop's server keeps answering first. Never while an update is starting or running.
    const claim = await claimRehearsal(client);
    if (claim.kind === 'start') {
      const child = spawn(
        join(programDir, 'artepool-svc.exe'),
        ['--data', dataDir, 'run', 'rehearsal', claim.id],
        { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv({}) },
      );
      if (child.pid) {
        try {
          setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          // Normal priority then: the rehearsal still runs.
        }
      }
      child.unref();
      log.line(`Rehearsal ${claim.id}: started.`);
    } else if (claim.kind === 'refused') {
      log.line(`Rehearsal ${claim.id}: not started, a shift is open.`);
    }
  }
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  if (await outcomeChanged(updatesDir, `failed: ${reason}`).catch(() => true)) {
    log.line(`Updater FAILED: ${reason}`);
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
