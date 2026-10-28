/**
 * The server PC's updater (decision 0108, M6.2 part G5). A scheduled task runs it as SYSTEM every
 * few minutes (`artepool-svc run updater`); each run:
 *
 *   1. records the result of the last update (the setup writes updates\last-result.json) and
 *      finishes the owner's "Install now" request it belonged to;
 *   2. every few hours, at once after an update, and at once for the owner's "Check now" (0110)
 *      or "Install now", reads the public update list. No internet is normal: everything keeps
 *      working and the update waits;
 *   3. downloads a newer server setup in the background into updates\, and keeps it only if its
 *      SHA-256 and its signature (the update key) are right;
 *   4. installs it only at a safe time: never while a shift is open; inside the night window, or
 *      at once after "Install now". A version that failed and was rolled back waits for "Install
 *      now". The setup itself makes the checked pre-upgrade backup, runs
 *      the migrations all or nothing and puts the previous version back on any failure (0103).
 *
 * The state is in ops.update_state (System health shows it); a refusal never runs anything.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import { inSystemTx } from '@artepool/backup';
import { compareVersions } from '../upgrade/steps';
import { verifyFileSignature } from './signature';

const versionText = z.string().regex(/^\d+\.\d+\.\d+$/);

/** What the server PC reads from latest.json (the release workflow writes it). */
export const latestSchema = z.object({
  version: versionText,
  pub_date: z.string().datetime({ offset: true }).optional(),
  notesAr: z.string().max(4000),
  notesEn: z.string().max(4000),
  server: z.object({
    url: z.string().url().startsWith('https://'),
    signature: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});
export type Latest = z.infer<typeof latestSchema>;

/** How often the update list is read when nobody asked (the "Install now" reads it at once). */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** A setup that has not written its result after this long is not "still installing". */
export const INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export type UpdaterOutcome =
  'no_key' | 'installing' | 'offline' | 'up_to_date' | 'download_failed' | 'waiting' | 'started';

export interface UpdaterDeps {
  /** As the backup role (it keeps ops.update_state and reads the shifts). */
  db: pg.Client;
  currentVersion: string;
  /** The update key's public half (empty: no update is ever accepted). */
  publicKey: string;
  updatesDir: string;
  fetchLatest: () => Promise<unknown>;
  download: (url: string, to: string) => Promise<void>;
  /** Starts the server setup silently and does not wait (it replaces this program's folder). */
  runSetup: (file: string) => void;
  now: () => Date;
  log: (line: string) => void;
}

interface State {
  checked_at: Date | null;
  check_requested_at: Date | null;
  available_version: string | null;
  download_status: string;
  waiting_reason: string | null;
  last_result: { at?: string; ok?: boolean; to?: string } | null;
  window_start_hour: number;
  window_end_hour: number;
}

interface Request {
  id: string;
  version: string;
  status: string;
}

/** The hour in the shop (Asia/Dubai) is inside the night window (which may cross midnight). */
export function inWindow(now: Date, startHour: number, endHour: number): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dubai',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(now),
  );
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

export const setupFileName = (version: string) => `ARTEPOOL-Server-Setup-${version}.exe`;

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runUpdater(deps: UpdaterDeps): Promise<UpdaterOutcome> {
  const { db, log } = deps;
  const now = deps.now();
  const save = (values: Record<string, unknown>, reason: string) =>
    inSystemTx(db, `updater: ${reason}`, async () => {
      const keys = Object.keys(values);
      await db.query(
        `UPDATE ops.update_state SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = 1`,
        keys.map((k) => values[k]),
      );
    });
  const setRequest = (id: string, status: string, error: string | null, reason: string) =>
    inSystemTx(db, `updater: ${reason}`, async () => {
      await db.query(
        'UPDATE ops.update_requests SET status = $2, error_message = $3 WHERE id = $1',
        [id, status, error],
      );
    });
  const readState = async () =>
    (await db.query<State>('SELECT * FROM ops.update_state WHERE id = 1')).rows[0]!;
  const openRequests = async () =>
    (
      await db.query<Request>(
        `SELECT id::text, version, status FROM ops.update_requests
          WHERE status IN ('pending', 'running') ORDER BY id`,
      )
    ).rows;

  // 1. The result of the last update, and the request it belonged to.
  const marker = join(deps.updatesDir, 'installing.json');
  const resultFile = join(deps.updatesDir, 'last-result.json');
  let state = await readState();
  if (existsSync(resultFile)) {
    const result = JSON.parse(await readFile(resultFile, 'utf8')) as {
      at?: string;
      ok?: boolean;
      to?: string;
      step?: string;
      detail?: string;
    };
    if (result.at && result.at !== state.last_result?.at) {
      await save({ last_result: JSON.stringify(result) }, 'the result of the last update');
      for (const request of await openRequests()) {
        if (request.status === 'running' && request.version === result.to) {
          await setRequest(
            request.id,
            result.ok ? 'done' : 'failed',
            result.ok ? null : `${result.step}: ${result.detail}`.slice(0, 2000),
            'the update finished',
          );
        }
      }
      await rm(marker, { force: true });
    }
  }
  await save({ current_version: deps.currentVersion }, 'the version running');
  // The version just installed is no longer "new": what was kept for it goes, and the update
  // list is read again at once (it says "up to date" or names a newer version).
  state = await readState();
  const installed = state.available_version;
  if (installed && compareVersions(installed, deps.currentVersion) <= 0) {
    await save(
      {
        available_version: null,
        notes_ar: null,
        notes_en: null,
        published_at: null,
        download_status: 'none',
        waiting_reason: null,
        checked_at: null,
      },
      `${installed} is installed`,
    );
    await rm(join(deps.updatesDir, setupFileName(installed)), { force: true });
    await rm(join(deps.updatesDir, `${setupFileName(installed)}.sig`), { force: true });
  }
  if (existsSync(marker)) {
    const started = JSON.parse(await readFile(marker, 'utf8')) as { at: string };
    if (now.getTime() - Date.parse(started.at) < INSTALL_TIMEOUT_MS) return 'installing';
    await rm(marker, { force: true });
  }
  state = await readState();
  if (state.waiting_reason === 'installing') {
    await save({ waiting_reason: null }, 'the setup has finished');
  }
  for (const request of await openRequests()) {
    if (request.status === 'running') {
      await setRequest(request.id, 'failed', 'The setup did not report a result.', 'no result');
    }
  }

  if (deps.publicKey.trim() === '') {
    await save(
      { check_error: 'The update key is not set: no update is accepted.', checked_at: now },
      'no update key',
    );
    return 'no_key';
  }

  // 2. The update list: every few hours, or at once after an update, for the owner's "Check now"
  //    or an "Install now".
  let requests = await openRequests();
  state = await readState();
  let latest: Latest | null = null;
  const checkAsked =
    state.check_requested_at !== null &&
    (!state.checked_at || state.check_requested_at.getTime() > state.checked_at.getTime());
  const due =
    requests.length > 0 ||
    checkAsked ||
    !state.checked_at ||
    now.getTime() - state.checked_at.getTime() >= CHECK_EVERY_MS ||
    state.download_status === 'failed';
  if (due) {
    try {
      latest = latestSchema.parse(await deps.fetchLatest());
      const newer = compareVersions(latest.version, deps.currentVersion) > 0;
      await save(
        {
          checked_at: now,
          check_error: null,
          available_version: newer ? latest.version : null,
          notes_ar: newer ? latest.notesAr : null,
          notes_en: newer ? latest.notesEn : null,
          published_at: newer && latest.pub_date ? new Date(latest.pub_date) : null,
          ...(newer ? {} : { download_status: 'none', waiting_reason: null }),
        },
        'the update list was read',
      );
    } catch (error) {
      log(`The update list could not be read: ${message(error)}`);
      await save(
        { checked_at: now, check_error: message(error).slice(0, 500) },
        'the update list could not be read',
      );
      if (!state.available_version) return 'offline';
    }
  }

  state = await readState();
  const version = state.available_version;
  if (!version || compareVersions(version, deps.currentVersion) <= 0) {
    for (const request of requests) {
      await setRequest(request.id, 'failed', 'This version is already installed.', 'nothing newer');
    }
    return 'up_to_date';
  }

  // 3. The download, kept only when its SHA-256 and its signature are right.
  const file = join(deps.updatesDir, setupFileName(version));
  const sigFile = `${file}.sig`;
  if (!(state.download_status === 'ready' && existsSync(file) && existsSync(sigFile))) {
    if (!latest || latest.version !== version) return 'offline';
    await save({ download_status: 'downloading' }, `downloading ${version}`);
    const partial = `${file}.partial`;
    try {
      await deps.download(latest.server.url, partial);
      if ((await sha256(partial)) !== latest.server.sha256) {
        throw new Error('The downloaded setup does not match its SHA-256.');
      }
      await verifyFileSignature(deps.publicKey, latest.server.signature, partial);
      await writeFile(sigFile, latest.server.signature);
      await rename(partial, file);
      await save({ download_status: 'ready' }, `${version} downloaded and checked`);
      log(`${setupFileName(version)} downloaded; its SHA-256 and signature are right.`);
    } catch (error) {
      await rm(partial, { force: true });
      log(`The download of ${version} was refused: ${message(error)}`);
      await save({ download_status: 'failed' }, `the download of ${version} was refused`);
      return 'download_failed';
    }
  }

  // 4. A safe time: no open shift; the night window, or the owner's "Install now".
  requests = await openRequests();
  const requested = requests.find((r) => r.status === 'pending');
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM cash.shifts WHERE status = 'open'`,
  );
  if ((rows[0]?.n ?? 0) > 0) {
    await save({ waiting_reason: 'open_shift' }, 'waiting: a shift is open');
    return 'waiting';
  }
  // A version that failed and was rolled back is not tried again by itself.
  if (!requested && state.last_result?.ok === false && state.last_result.to === version) {
    await save({ waiting_reason: 'failed_before' }, 'waiting: this version failed before');
    return 'waiting';
  }
  if (!requested && !inWindow(now, state.window_start_hour, state.window_end_hour)) {
    await save({ waiting_reason: 'outside_window' }, 'waiting for the night window');
    return 'waiting';
  }
  // Checked again right before it runs: the file on disk is what was verified.
  try {
    await verifyFileSignature(deps.publicKey, await readFile(sigFile, 'utf8'), file);
  } catch (error) {
    await rm(file, { force: true });
    await save({ download_status: 'failed' }, 'the downloaded setup changed on disk');
    log(`The downloaded setup was refused before running: ${message(error)}`);
    return 'download_failed';
  }
  if (requested) await setRequest(requested.id, 'running', null, `installing ${version}`);
  await writeFile(marker, `${JSON.stringify({ version, at: now.toISOString() })}\n`);
  await save({ waiting_reason: 'installing' }, `installing ${version}`);
  log(`Installing ${version}.`);
  deps.runSetup(file);
  return 'started';
}

/**
 * The scheduled task runs every few minutes: its log gets a line only when what it has to say
 * changes (the same "no key", "offline" or "waiting" every five minutes says nothing new). The
 * last one is kept in updates\last-outcome.txt.
 */
export async function outcomeChanged(updatesDir: string, outcome: string): Promise<boolean> {
  const file = join(updatesDir, 'last-outcome.txt');
  const previous = existsSync(file) ? (await readFile(file, 'utf8')).trim() : null;
  if (previous === outcome) return false;
  await writeFile(file, `${outcome}\n`);
  return true;
}
