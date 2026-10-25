/**
 * The restore from a backup on a new server PC (decision 0102, M6.2 part E), around the engine in
 * `@artepool/backup` (full-restore.ts): the services stopped and started, the copy's master key put
 * back into the protected store, then, on the restored data, an enrollment code for this PC, a
 * fresh local copy and a restore test. The wizard's setup token is removed: the restored
 * installation is already set up, so the wizard stays locked.
 *
 * The installed server (Windows) stops and starts its services with `sc.exe` and puts the master
 * key back through the launcher (`artepool-svc secrets set master-key`, DPAPI). In development the
 * master key file is replaced (the old one kept beside it) and `pnpm dev:server` is restarted by
 * hand.
 */
import { execFile } from 'node:child_process';
import { copyFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  childEnv,
  connectionFor,
  isInstalled,
  masterKeySource,
  migrationsDir,
  type PgConnection,
} from '@artepool/node-kit';
import {
  configFromEnv,
  connect,
  fullRestore,
  localBackup,
  restoreTest,
  type FullRestoreResult,
  type RestoreHooks,
  type RestoreStep,
} from '@artepool/backup';
import { migrate } from '@artepool/migrate';
import { privateKeyIn } from '@artepool/shared/contracts';
import { SettingsCache } from '../platform/settings';
import { createDb, createPool } from '../platform/db/pool';
import { createConsoleCode } from './bootstrap';

/** The Windows services the installer creates (M6.2 part F), by service name. */
export const WINDOWS_SERVICES = ['ArtepoolServer', 'ArtepoolBackup'] as const;

/** What the wizard reads: one JSON object per line on the standard output. */
export type RestoreMessage =
  { step: RestoreStep | 'enrolling' | 'backing_up' } | { result: RestoreOutcome };

export type RestoreOutcome =
  | (Extract<FullRestoreResult, { ok: true }> & {
      /** A one-time code to enroll this PC on the restored server (as in 0024). */
      enrollment: { code: string; expiresAt: string } | null;
      /** The fresh local copy and its restore test, on the restored data. */
      backup: { ok: boolean; fileName: string | null; detail?: string };
    })
  | Extract<FullRestoreResult, { ok: false }>;

export type Exec = (file: string, args: string[], input?: string) => Promise<string>;

export const exec: Exec = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { env: childEnv({}), windowsHide: true },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`${file} ${args.join(' ')}: ${stderr || error.message}`))
          : resolve(stdout),
    );
    if (input !== undefined) child.stdin?.end(input);
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The service is not installed (sc.exe error 1060): nothing to stop or start. */
const notInstalled = (error: unknown) => error instanceof Error && error.message.includes('1060');

/** The installed server's hooks: Windows services and the launcher's protected store. */
export function windowsHooks(options: {
  programDir: string;
  dataDir: string;
  exec?: Exec;
  pollMs?: number;
}): Pick<RestoreHooks, 'stopServices' | 'startServices' | 'saveMasterKey'> {
  const run = options.exec ?? exec;
  const pollMs = options.pollMs ?? 500;
  const waitFor = async (service: string, state: 'STOPPED' | 'RUNNING') => {
    for (let i = 0; i < 120; i++) {
      const out = await run('sc.exe', ['query', service]);
      if (new RegExp(`STATE\\s*:\\s*\\d+\\s+${state}`).test(out)) return;
      await sleep(pollMs);
    }
    throw new Error(`The service ${service} did not reach ${state} within a minute.`);
  };
  return {
    async stopServices() {
      for (const service of WINDOWS_SERVICES) {
        try {
          const out = await run('sc.exe', ['query', service]);
          if (/STATE\s*:\s*\d+\s+STOPPED/.test(out)) continue;
          await run('sc.exe', ['stop', service]);
        } catch (error) {
          if (notInstalled(error)) continue;
          throw error;
        }
        await waitFor(service, 'STOPPED');
      }
    },
    async startServices() {
      for (const service of WINDOWS_SERVICES) {
        try {
          await run('sc.exe', ['start', service]);
        } catch (error) {
          if (notInstalled(error)) continue;
          throw error;
        }
        await waitFor(service, 'RUNNING');
      }
    },
    async saveMasterKey(key) {
      await run(
        join(options.programDir, 'artepool-svc.exe'),
        ['--data', options.dataDir, 'secrets', 'set', 'master-key'],
        key.toString('base64'),
      );
    },
  };
}

const stamp = (now: Date) => now.toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** Development: the master key file replaced, the old one kept beside it; services by hand. */
export function developmentHooks(
  keyFile: string,
  now: Date = new Date(),
): Pick<RestoreHooks, 'stopServices' | 'startServices' | 'saveMasterKey'> {
  return {
    stopServices: () => Promise.resolve(),
    startServices: () => Promise.resolve(),
    async saveMasterKey(key) {
      await copyFile(keyFile, `${keyFile}.before-restore-${stamp(now)}`).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await writeFile(keyFile, key.toString('base64'), { mode: 0o600 });
    },
  };
}

export interface RestoreFromBackupInput {
  copy: Buffer;
  privateKey: string | null;
  report: (message: RestoreMessage) => void;
  /** Defaults from the environment (installed server or `.env`). */
  liveDatabase?: string;
  superuser?: PgConnection;
  hooks?: Pick<RestoreHooks, 'stopServices' | 'startServices' | 'saveMasterKey'>;
  setupTokenFile?: string;
  now?: Date;
}

function defaultHooks(): Pick<RestoreHooks, 'stopServices' | 'startServices' | 'saveMasterKey'> {
  if (isInstalled()) {
    const programDir = process.env.ARTEPOOL_PROGRAM_DIR;
    const dataDir = process.env.ARTEPOOL_DATA_DIR;
    if (!programDir || !dataDir) {
      throw new Error(
        'The restore is started by artepool-svc (run restore), which sets its folders.',
      );
    }
    return windowsHooks({ programDir, dataDir });
  }
  const source = masterKeySource();
  if (!('file' in source)) throw new Error('No master key file in development.');
  return developmentHooks(source.file);
}

/**
 * The private key from the restore program's input: the key line alone, as the setup screen
 * does, since the key file (or a paste) may hold comment lines around it. Text with no key in it
 * goes on as typed, and is refused as a wrong key; nothing at all means a plain copy.
 */
export function keyFromInput(text: string): string | null {
  return privateKeyIn(text) ?? (text.trim() || null);
}

export async function restoreFromBackup(input: RestoreFromBackupInput): Promise<RestoreOutcome> {
  const backupConfig = configFromEnv(input.liveDatabase);
  const liveDatabase = backupConfig.connection.database;
  const restored = await fullRestore({
    copy: input.copy,
    privateKey: input.privateKey,
    superuser: input.superuser ?? connectionFor('superuser'),
    liveDatabase,
    pgBin: backupConfig.pgBin,
    workDir: backupConfig.backupDir,
    now: input.now,
    hooks: {
      ...(input.hooks ?? defaultHooks()),
      upgrade: async (client) => {
        await migrate({ client, dir: migrationsDir });
      },
      progress: (step) => input.report({ step }),
    },
  });
  if (!restored.ok) return restored;

  // The wizard is locked: the restored installation is already set up.
  const tokenFile = input.setupTokenFile ?? process.env.ARTEPOOL_SETUP_TOKEN_FILE;
  if (tokenFile) await unlink(tokenFile).catch(() => undefined);

  input.report({ step: 'enrolling' });
  // Without a code (should one fail), `artepool-svc run device-code` gives one.
  let enrollment: { code: string; expiresAt: string } | null;
  const db = createDb(createPool(connectionFor('api', liveDatabase), 2));
  try {
    const { code, expiresAt } = await createConsoleCode(
      db,
      new SettingsCache(db),
      'restore from backup: enrollment code for the new server PC',
    );
    enrollment = { code, expiresAt: expiresAt.toISOString() };
  } catch {
    enrollment = null;
  } finally {
    await db.destroy();
  }

  input.report({ step: 'backing_up' });
  let backup: Extract<RestoreOutcome, { ok: true }>['backup'];
  try {
    const client = await connect(backupConfig.connection);
    try {
      await localBackup(client, backupConfig);
      const test = await restoreTest(client, backupConfig);
      backup = { ok: test.ok, fileName: test.fileName };
    } finally {
      await client.end();
    }
  } catch (error) {
    // The restore stands; the backup service makes the next copy within the hour.
    backup = {
      ok: false,
      fileName: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return { ...restored, enrollment, backup };
}
