/**
 * Restore from a backup in development (the Windows app's Rust layer does the same, decision
 * 0102): the copies are looked for in a few folders, and the restore program
 * (`apps/server/src/cli/restore.ts`, through tsx) is started with the private key on its standard
 * input. Its JSON lines are kept for the screens to ask about.
 *
 * Where it looks: the setup file's `restore` part (ARTEPOOL_DEV_SETUP_FILE, written by the screen
 * tests: `{ places: string[], env: { ARTEPOOL_DB, … } }`); otherwise `.backups` and the Downloads
 * folder, with the development settings from `.env`.
 */
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { repoRoot } from '@artepool/node-kit';
import {
  PRIVATE_KEY,
  RESTORE_COPY_NAME,
  type RestoreCopy,
  type RestoreFailure,
  type RestorePlace,
  type RestoreResult,
  type RestoreStart,
  type RestoreStatus,
} from '@artepool/shared/contracts';
import { setupFiles } from './setup';

/** The external drive's folder (decision 0086). */
const DRIVE_FOLDER = 'ARTEPOOL-BACKUPS';
const MAX_LISTED = 50;

interface RestoreSettings {
  places: { dir: string; place: RestorePlace }[];
  env: Record<string, string>;
  tokenFile: string;
}

async function settings(): Promise<RestoreSettings> {
  const files = (await setupFiles()) as Awaited<ReturnType<typeof setupFiles>> & {
    restore?: { places?: string[]; env?: Record<string, string> };
  };
  if (files.restore) {
    return {
      places: (files.restore.places ?? []).map((dir) => ({ dir, place: 'removable' as const })),
      env: files.restore.env ?? {},
      tokenFile: files.tokenFile,
    };
  }
  return {
    places: [
      { dir: join(repoRoot, '.backups'), place: 'backups' },
      { dir: join(homedir(), 'Downloads'), place: 'downloads' },
    ],
    env: {},
    tokenFile: files.tokenFile,
  };
}

/** The setup token is still on this PC (the restore is for a fresh installation only). */
async function available(tokenFile: string): Promise<boolean> {
  return stat(tokenFile).then(
    (s) => s.isFile(),
    () => false,
  );
}

export async function copyAt(path: string, place: RestorePlace): Promise<RestoreCopy | null> {
  const name = basename(path);
  if (!RESTORE_COPY_NAME.test(name)) return null;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return {
      path,
      name,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      place,
      encrypted: /\.age$/i.test(name),
    };
  } catch {
    return null;
  }
}

export async function restoreCopies(path?: string): Promise<RestoreCopy[]> {
  const found = await settings();
  if (!(await available(found.tokenFile))) return [];
  if (path) {
    const copy = await copyAt(path.trim(), 'typed');
    return copy ? [copy] : [];
  }
  const copies: RestoreCopy[] = [];
  for (const { dir, place } of found.places) {
    for (const folder of [dir, join(dir, DRIVE_FOLDER)]) {
      const names = await readdir(folder).catch(() => [] as string[]);
      for (const name of names) {
        const copy = await copyAt(join(folder, name), place);
        if (copy && !copies.some((c) => c.path === copy.path)) copies.push(copy);
      }
    }
  }
  return copies.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, MAX_LISTED);
}

let status: RestoreStatus = { running: false, step: null, result: null };

export function restoreStatus(): RestoreStatus {
  return status;
}

/** Starts the restore; the result arrives later in `restoreStatus()`. */
export async function restoreStart(
  request: RestoreStart,
): Promise<{ started: true } | { started: false; reason: RestoreFailure }> {
  if (status.running) return { started: false, reason: 'busy' };
  if (request.privateKey && !PRIVATE_KEY.test(request.privateKey)) {
    return { started: false, reason: 'wrong_key' };
  }
  const found = await settings();
  if (!(await available(found.tokenFile))) return { started: false, reason: 'unavailable' };
  status = { running: true, step: null, result: null };
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(repoRoot, 'apps', 'server', 'src', 'cli', 'restore.ts'), request.path],
    {
      cwd: repoRoot,
      env: { ...process.env, ...found.env, ARTEPOOL_SETUP_TOKEN_FILE: found.tokenFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line) as { step?: string; result?: RestoreResult };
      if (typeof message.step === 'string') {
        status = { ...status, step: message.step as RestoreStatus['step'] };
      } else if (message.result && typeof message.result.ok === 'boolean') {
        status = { ...status, result: message.result };
      }
    } catch {
      // not one of the program's lines
    }
  });
  const finish = (detail: string) => {
    status = {
      ...status,
      running: false,
      result: status.result ?? { ok: false, reason: 'launch_failed', detail },
    };
  };
  child.on('error', (error) => finish(error.message));
  child.on('close', () =>
    finish(errors.trim().split('\n').pop() || 'The restore program stopped without a result.'),
  );
  child.stdin.end(`${request.privateKey}\n`);
  return { started: true };
}

/** Tests only. */
export function forgetRestore(): void {
  status = { running: false, step: null, result: null };
}
