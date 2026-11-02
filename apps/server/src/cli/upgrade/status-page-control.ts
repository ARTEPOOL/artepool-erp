/**
 * Starting and stopping the status page (decision 0115, 0.9.0) from the upgrade program.
 *
 * `upgrade prepare` starts it right after the server stops: node.exe and `status-page.mjs` are
 * copied into `updates\status-page` first, so the running page never holds a file in the program
 * folders the setup swaps. `upgrade apply` stops it before the new server starts, and on a failure
 * before the setup starts the previous version again. Starting it never stops an update (it is
 * only there to show the steps); stopping it is waited for, and as a last resort its process is
 * ended, because the server needs the port back.
 *
 * Its record (`updates\status-page.json`) says when it started and stopped, why it stopped, and
 * how many requests it answered, refused and limited; the update's result keeps it.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';

export const statusPageRecordSchema = z.object({
  pid: z.number().int(),
  startedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  stopReason: z.string().nullable(),
  answers: z.object({
    status: z.number().int(),
    refused: z.number().int(),
    limited: z.number().int(),
  }),
  error: z.string().nullable(),
});
export type StatusPageRecord = z.infer<typeof statusPageRecordSchema>;

/** The files the status page and the upgrade program share, in `updates\`. */
export function statusPageFiles(updatesDir: string) {
  return {
    folder: join(updatesDir, 'status-page'),
    record: join(updatesDir, 'status-page.json'),
    stop: join(updatesDir, 'status-page.stop'),
    progress: join(updatesDir, 'progress.json'),
  };
}

export async function readStatusPageRecord(file: string): Promise<StatusPageRecord | null> {
  try {
    return statusPageRecordSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return null;
  }
}

let written = 0;

/** Written beside under its own name, then renamed into place: never half a record. */
export async function writeStatusPageRecord(file: string, record: StatusPageRecord): Promise<void> {
  const next = `${file}.${process.pid}-${(written += 1)}.next`;
  await writeFile(next, `${JSON.stringify(record, null, 2)}\n`);
  await rename(next, file);
}

export interface StatusPageControl {
  /** Starts it and waits until it answers; a failure is only logged. */
  start(): Promise<void>;
  /** Stops it and waits until the port is free (at once when it is not running). */
  stop(): Promise<StatusPageRecord | null>;
}

export interface StatusPageOptions {
  updatesDir: string;
  /** The Node running the upgrade program (the new version's), copied out. */
  nodeExe: string;
  /** `status-page.mjs` of the new version. */
  script: string;
  host: string;
  port: number;
  certFile: string;
  keyFile: string;
  /** It stops by itself after this long. */
  minutes?: number;
  log: (line: string) => void;
  spawn?: (command: string, args: string[]) => void;
  /** How long start and stop wait (tests use less). */
  waitMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function statusPageControl(options: StatusPageOptions): StatusPageControl {
  const files = statusPageFiles(options.updatesDir);
  const waitMs = options.waitMs ?? 15_000;
  const until = async (done: () => Promise<boolean>): Promise<boolean> => {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (await done()) return true;
      await sleep(200);
    }
    return done();
  };
  const run =
    options.spawn ??
    ((command: string, args: string[]) =>
      spawnProcess(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref());

  return {
    async start() {
      try {
        await mkdir(files.folder, { recursive: true });
        const node = join(files.folder, basename(options.nodeExe));
        const script = join(files.folder, 'status-page.mjs');
        await copyFile(options.nodeExe, node);
        await copyFile(options.script, script);
        await rm(files.stop, { force: true });
        await rm(files.record, { force: true });
        run(node, [
          script,
          '--host',
          options.host,
          '--port',
          String(options.port),
          '--cert',
          options.certFile,
          '--key',
          options.keyFile,
          '--dir',
          options.updatesDir,
          '--minutes',
          String(options.minutes ?? 60),
        ]);
        const started = await until(async () => {
          const record = await readStatusPageRecord(files.record);
          return record !== null && (record.startedAt !== null || record.stoppedAt !== null);
        });
        const record = await readStatusPageRecord(files.record);
        if (started && record?.startedAt) {
          options.log(
            `The status page answers on port ${options.port} while the server is stopped.`,
          );
        } else {
          options.log(
            `The status page did not start (${record?.error ?? 'no answer'}); the update goes on.`,
          );
        }
      } catch (error) {
        options.log(
          `The status page did not start (${error instanceof Error ? error.message : String(error)}); the update goes on.`,
        );
      }
    },

    async stop() {
      const before = await readStatusPageRecord(files.record);
      if (!before) return null;
      if (before.stoppedAt) return before;
      await writeFile(files.stop, '');
      const stopped = await until(
        async () => (await readStatusPageRecord(files.record))?.stoppedAt != null,
      );
      if (!stopped) {
        // The server needs the port back: the page's own process is ended.
        try {
          process.kill(before.pid);
        } catch {
          // Already gone.
        }
        await sleep(1000);
        const ended = (await readStatusPageRecord(files.record)) ?? before;
        await writeStatusPageRecord(files.record, {
          ...ended,
          stoppedAt: ended.stoppedAt ?? new Date().toISOString(),
          stopReason: ended.stopReason ?? 'ended',
        });
      }
      const record = await readStatusPageRecord(files.record);
      options.log(`The status page stopped (${record?.stopReason ?? 'unknown'}).`);
      if (existsSync(files.stop)) await rm(files.stop, { force: true });
      return record;
    },
  };
}
