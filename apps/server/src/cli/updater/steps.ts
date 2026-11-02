/**
 * The server PC's updater (decision 0108, M6.2 part G5). A scheduled task runs it as SYSTEM every
 * few minutes (`artepool-svc run updater`); each run:
 *
 *   1. records the result of the last update (the setup writes updates\last-result.json) and
 *      finishes the owner's "Install now" request it belonged to;
 *   2. every hour, at once after an update, and at once for the owner's "Check now" (0110)
 *      or "Install now", reads the public update list. No internet is normal: everything keeps
 *      working and the update waits;
 *   3. downloads a newer version in the background into updates\ as soon as it is known, with
 *      its progress (0115), continuing after a cut where it stopped; keeps a file only if its
 *      SHA-256 and its signature (the update key) are right. The smallest package that fits
 *      (0115, 0.9.0): the update package alone when this PC has the runtime it needs; with the
 *      runtime package when not; the full setup when the PC's runtime is unknown, the list has
 *      no small packages, or a small package was refused or failed for this version;
 *   4. installs it only at a safe time: never while a shift is open; inside the night window, or
 *      at once after "Install now". A version that failed and was rolled back waits for "Install
 *      now". The setup itself makes the checked pre-upgrade backup, runs
 *      the migrations all or nothing and puts the previous version back on any failure (0103).
 *
 * The state is in ops.update_state (System health shows it); a refusal never runs anything.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import { inSystemTx } from '@artepool/backup';
import { runtimeFileName, runtimeZipRefusals } from '@artepool/release';
import { checkRuntime, compareVersions } from '../upgrade/steps';
import type { Progress } from './download';
import { verifyFileSignature } from './signature';

const versionText = z.string().regex(/^\d+\.\d+\.\d+$/);

const runtimeId = z.string().regex(/^[0-9a-f]{12}$/);

/** A download in the update list: its address, signature, SHA-256 and size. */
const listedFile = z.object({
  url: z.string().url().startsWith('https://'),
  signature: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive().optional(),
});

/**
 * What the server PC reads from latest.json (the release workflow writes it). `server` is the full
 * setup; `serverUpdate` (the programs only, for the runtime it names) and `runtime` (PostgreSQL,
 * Node and WinSW) are the small packages of decision 0115. A list without them, or with a part
 * that is not right, still gives the full setup: such a part is simply left out.
 */
export const latestSchema = z.object({
  version: versionText,
  pub_date: z.string().datetime({ offset: true }).optional(),
  notesAr: z.string().max(4000),
  notesEn: z.string().max(4000),
  server: listedFile,
  serverUpdate: listedFile
    .extend({ runtime: runtimeId })
    .optional()
    .catch(() => undefined),
  runtime: listedFile
    .extend({ id: runtimeId })
    .optional()
    .catch(() => undefined),
});
export type Latest = z.infer<typeof latestSchema>;

/** How often the update list is read when nobody asked (0115; "Check now" reads it at once). */
export const CHECK_EVERY_MS = 60 * 60 * 1000;
/** The download's progress is written at most this often (0115). */
export const PROGRESS_EVERY_MS = 1000;
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
  /** Into `to`, continuing a part already there (0115), reporting what has arrived. */
  download: (url: string, to: string, onProgress: Progress) => Promise<void>;
  /** The runtime installed beside the programs (`runtime.json`); null before 0.9.0 (0115). */
  installedRuntime: () => Promise<string | null>;
  /** Unpacks a checked runtime package into an empty folder (Windows' own tar, 0115). */
  unzip: (zip: string, to: string) => Promise<void>;
  /**
   * Starts the setup silently and does not wait (it replaces this program's folder); with the
   * folder of the unpacked runtime package when the update package needs it (0115).
   */
  runSetup: (file: string, runtimeDir: string | null) => void;
  now: () => Date;
  log: (line: string) => void;
  /** A clock in milliseconds for spacing the progress writes (Date.now by default). */
  clock?: () => number;
}

/** No download in progress: the progress columns are emptied (0115). */
const NO_PROGRESS = {
  download_bytes: null,
  download_total: null,
  download_rate: null,
  progress_at: null,
};

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
export const updateFileName = (version: string) => `ARTEPOOL-Server-Update-${version}.exe`;
export const runtimeDirName = (id: string) => `runtime-${id}`;
/** Beside the downloads: this version is installed with the full setup from now on (0115). */
export const useFullMarker = (version: string) => `use-full-${version}`;

/** Which package installs the version (decision 0115). */
export type PackageKind = 'full' | 'update' | 'update_runtime';

export interface PlannedFile {
  role: 'full' | 'update' | 'runtime';
  name: string;
  url: string;
  signature: string;
  sha256: string;
  size: number | null;
}

export interface Plan {
  version: string;
  kind: PackageKind;
  /** The runtime the update package needs (null for the full setup). */
  runtimeId: string | null;
  /** The runtime package first (when needed), the setup last. */
  files: PlannedFile[];
}

/**
 * The smallest package that installs `latest` on this PC (0115): the update package when the PC
 * has the runtime it needs; with the runtime package when the list has the one it needs; the full
 * setup otherwise, when the PC's runtime is unknown (installed before 0.9.0), or when a small
 * package was refused or failed for this version.
 */
export function choosePlan(
  latest: Latest,
  installedRuntime: string | null,
  useFull: boolean,
): Plan {
  const file = (
    role: PlannedFile['role'],
    name: string,
    f: { url: string; signature: string; sha256: string; size?: number | undefined },
  ): PlannedFile => ({
    role,
    name,
    url: f.url,
    signature: f.signature,
    sha256: f.sha256,
    size: f.size ?? null,
  });
  const v = latest.version;
  const full: Plan = {
    version: v,
    kind: 'full',
    runtimeId: null,
    files: [file('full', setupFileName(v), latest.server)],
  };
  const update = latest.serverUpdate;
  if (useFull || !update || !installedRuntime) return full;
  const updateFile = file('update', updateFileName(v), update);
  if (update.runtime === installedRuntime) {
    return { version: v, kind: 'update', runtimeId: update.runtime, files: [updateFile] };
  }
  if (latest.runtime && latest.runtime.id === update.runtime) {
    return {
      version: v,
      kind: 'update_runtime',
      runtimeId: update.runtime,
      files: [file('runtime', runtimeFileName(update.runtime), latest.runtime), updateFile],
    };
  }
  return full;
}

const planSchema = z.object({
  version: versionText,
  kind: z.enum(['full', 'update', 'update_runtime']),
  runtimeId: z
    .string()
    .regex(/^[0-9a-f]{12}$/)
    .nullable(),
  files: z
    .array(
      z.object({
        role: z.enum(['full', 'update', 'runtime']),
        name: z.string().regex(/^ARTEPOOL-[A-Za-z0-9.-]+\.(exe|zip)$/),
        url: z.string(),
        signature: z.string(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        size: z.number().int().nullable(),
      }),
    )
    .min(1),
});

/** What is downloaded for (or into) the version: `updates\plan.json` (0115). */
async function readPlan(updatesDir: string, version: string): Promise<Plan | null> {
  try {
    const plan = planSchema.parse(
      JSON.parse(await readFile(join(updatesDir, 'plan.json'), 'utf8')),
    );
    return plan.version === version ? plan : null;
  } catch {
    return null;
  }
}

/** Everything kept for versions that are installed now (0115). */
const UPDATE_LEFTOVERS = [
  /^ARTEPOOL-Server-(Setup|Update)-/,
  /^ARTEPOOL-Runtime-/,
  /^runtime-[0-9a-f]{12}(\.partial)?$/,
  /^use-full-/,
  /^plan\.json$/,
];

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
      // A small package that did not install (0115): the next try of that version takes the full
      // setup, whatever the reason.
      const started = existsSync(marker)
        ? (JSON.parse(await readFile(marker, 'utf8')) as { version?: string; package?: string })
        : null;
      if (!result.ok && result.to && started?.version === result.to && started.package) {
        if (started.package !== 'full') {
          await writeFile(join(deps.updatesDir, useFullMarker(result.to)), '');
          await rm(join(deps.updatesDir, 'plan.json'), { force: true });
          log(
            `${result.to} did not install with the ${started.package} package; the full setup is used next.`,
          );
        }
      }
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
        ...NO_PROGRESS,
      },
      `${installed} is installed`,
    );
    for (const name of await readdir(deps.updatesDir)) {
      if (UPDATE_LEFTOVERS.some((pattern) => pattern.test(name))) {
        await rm(join(deps.updatesDir, name), { recursive: true, force: true });
      }
    }
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
          ...(newer ? {} : { download_status: 'none', waiting_reason: null, ...NO_PROGRESS }),
          // Another version than the one being downloaded: its progress starts again.
          ...(newer && latest.version !== state.available_version ? NO_PROGRESS : {}),
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

  // 3. The download, in advance as soon as a newer version is known (0115), kept only when its
  //    SHA-256 and its signature are right. A cut keeps what arrived: the next run continues. The
  //    smallest package that fits; the full setup after a small one was refused or failed.
  const dir = deps.updatesDir;
  const useFull = existsSync(join(dir, useFullMarker(version)));
  let plan = await readPlan(dir, version);
  if (plan && useFull && plan.kind !== 'full') plan = null;
  const have = (f: PlannedFile) =>
    existsSync(join(dir, f.name)) && existsSync(join(dir, `${f.name}.sig`));
  if (!(plan && state.download_status === 'ready' && plan.files.every(have))) {
    // The server may have read the list itself for the owner's "Check now" (0115): the address
    // and the checks always come from the list read here, by the updater.
    if (!latest) {
      try {
        latest = latestSchema.parse(await deps.fetchLatest());
      } catch (error) {
        log(`The update list could not be read: ${message(error)}`);
        return 'offline';
      }
    }
    if (latest.version !== version) return 'offline';
    plan = choosePlan(latest, await deps.installedRuntime(), useFull);
    await writeFile(join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    const sizes = plan.files.map((f) => f.size);
    const total = sizes.every((n) => n !== null) ? sizes.reduce((a, b) => a + b, 0) : null;
    await save({ download_status: 'downloading' }, `downloading ${version} (${plan.kind})`);
    const progress = progressWriter(
      (values) => save(values, 'download progress'),
      deps.clock ?? Date.now,
      deps.now,
    );
    let offset = 0;
    for (const f of plan.files) {
      const target = join(dir, f.name);
      const sigFile = `${target}.sig`;
      // Kept from an earlier run, checked then (and again right before it runs).
      if (have(f) && (await readFile(sigFile, 'utf8')) === f.signature) {
        offset += (await stat(target)).size;
        progress.report(offset, total);
        continue;
      }
      const partial = `${target}.partial`;
      // What the part already received belongs to; another address or SHA-256 starts again.
      const note = `${partial}.json`;
      const expected = JSON.stringify({ url: f.url, sha256: f.sha256 });
      if (
        existsSync(partial) &&
        (!existsSync(note) || (await readFile(note, 'utf8')) !== expected)
      ) {
        await rm(partial, { force: true });
      }
      await writeFile(note, expected);
      const base = offset;
      try {
        await deps.download(f.url, partial, (received, fileTotal) =>
          progress.report(base + received, total ?? (fileTotal === null ? null : base + fileTotal)),
        );
      } catch (error) {
        await progress.flush();
        log(`The download of ${version} stopped; the next run continues it: ${message(error)}`);
        await save({ download_status: 'failed' }, `the download of ${version} stopped`);
        return 'download_failed';
      }
      try {
        if ((await sha256(partial)) !== f.sha256) {
          throw new Error(`The downloaded ${f.name} does not match its SHA-256.`);
        }
        await verifyFileSignature(deps.publicKey, f.signature, partial);
        await writeFile(sigFile, f.signature);
        await rename(partial, target);
        await rm(note, { force: true });
      } catch (error) {
        await progress.flush();
        await rm(partial, { force: true });
        await rm(note, { force: true });
        log(`The download of ${version} was refused: ${message(error)}`);
        if (f.role !== 'full') {
          // Never the small package again for this version: the full setup, checked the same way.
          await writeFile(join(dir, useFullMarker(version)), '');
          log(`${version} will be installed with the full setup.`);
        }
        await save(
          { download_status: 'failed', ...NO_PROGRESS },
          `the download of ${version} was refused`,
        );
        return 'download_failed';
      }
      offset += f.size ?? (await stat(target)).size;
    }
    await progress.flush();
    await save({ download_status: 'ready' }, `${version} downloaded and checked`);
    log(`${version} downloaded (${plan.kind}); its SHA-256 and signature are right.`);
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
  // Checked again right before it runs: the files on disk are what was verified.
  for (const f of plan.files) {
    try {
      await verifyFileSignature(
        deps.publicKey,
        await readFile(join(dir, `${f.name}.sig`), 'utf8'),
        join(dir, f.name),
      );
    } catch (error) {
      await rm(join(dir, f.name), { force: true });
      await save({ download_status: 'failed' }, 'a downloaded file changed on disk');
      log(`${f.name} was refused before running: ${message(error)}`);
      return 'download_failed';
    }
  }
  // The runtime package, unpacked now from the file just checked; its names checked first.
  let runtimeDir: string | null = null;
  const runtime = plan.files.find((f) => f.role === 'runtime');
  if (runtime && plan.runtimeId) {
    const target = join(dir, runtimeDirName(plan.runtimeId));
    const unpacking = `${target}.partial`;
    try {
      const refused = await runtimeZipRefusals(join(dir, runtime.name));
      if (refused.length > 0) throw new Error(`Refused: ${refused.join('; ')}`);
      await rm(unpacking, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
      await mkdir(unpacking, { recursive: true });
      await deps.unzip(join(dir, runtime.name), unpacking);
      await checkRuntime(unpacking, plan.runtimeId);
      await rename(unpacking, target);
      runtimeDir = target;
    } catch (error) {
      await rm(unpacking, { recursive: true, force: true });
      await rm(join(dir, runtime.name), { force: true });
      await writeFile(join(dir, useFullMarker(version)), '');
      await save({ download_status: 'failed', ...NO_PROGRESS }, 'the runtime package was refused');
      log(
        `The runtime package of ${version} was refused; the full setup is used next: ${message(error)}`,
      );
      return 'download_failed';
    }
  }
  const setupFile = join(dir, plan.files.at(-1)!.name);
  if (requested) await setRequest(requested.id, 'running', null, `installing ${version}`);
  await writeFile(
    marker,
    `${JSON.stringify({ version, at: now.toISOString(), package: plan.kind })}\n`,
  );
  await save({ waiting_reason: 'installing' }, `installing ${version}`);
  log(`Installing ${version} (${plan.kind}).`);
  deps.runSetup(setupFile, runtimeDir);
  return 'started';
}

/**
 * The download's progress in ops.update_state (0115): what has arrived, the total, the speed since
 * this run began, written at most once a second (the audit log ignores these columns), and once
 * more at the end. A failed write never stops the download.
 */
function progressWriter(
  save: (values: Record<string, unknown>) => Promise<unknown>,
  clock: () => number,
  now: () => Date,
) {
  const began = clock();
  let firstBytes: number | null = null;
  let lastWrite = Number.NEGATIVE_INFINITY;
  let pending: [number, number | null] | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const write = ([received, total]: [number, number | null]) => {
    const seconds = (clock() - began) / 1000;
    const rate = seconds > 0 ? Math.round((received - (firstBytes ?? received)) / seconds) : 0;
    chain = chain
      .then(() =>
        save({
          download_bytes: received,
          download_total: total,
          download_rate: Math.max(0, rate),
          progress_at: now(),
        }),
      )
      .catch(() => undefined);
  };
  return {
    report: (received: number, total: number | null) => {
      firstBytes ??= received;
      pending = [received, total];
      if (clock() - lastWrite >= PROGRESS_EVERY_MS) {
        lastWrite = clock();
        write(pending);
        pending = null;
      }
    },
    flush: async () => {
      if (pending) write(pending);
      pending = null;
      await chain;
    },
  };
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
