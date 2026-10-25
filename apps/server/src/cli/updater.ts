/**
 * `artepool-svc run updater` — the server PC's updater (decision 0108, M6.2 part G5), run every
 * few minutes as SYSTEM by the scheduled task "ARTEPOOL Updater"; the steps are in
 * updater/steps.ts. Its lines go to `logs\install\updater.log`, only when the outcome changes
 * (no secret is ever written).
 */
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { LATEST_URL } from '@artepool/release';
import { connectionFor, loadEnv, resourcePath } from '@artepool/node-kit';
import { InstallLog } from './install/log';
import { outcomeChanged, runUpdater } from './updater/steps';

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
    download: async (url, to) => {
      const response = await fetchOk(url, 60 * 60 * 1000);
      if (!response.body) throw new Error(`${url}: no content`);
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(to));
    },
    runSetup: (file) => {
      // Detached: the setup replaces this program's folder, so the updater ends first.
      spawn(file, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    },
    now: () => new Date(),
    log: (line) => log.line(line),
  });
  if (await outcomeChanged(updatesDir, outcome)) log.line(`Updater: ${outcome}.`);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  if (await outcomeChanged(updatesDir, `failed: ${reason}`).catch(() => true)) {
    log.line(`Updater FAILED: ${reason}`);
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
