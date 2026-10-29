/**
 * The backup service's schedule (decision 0086), checked every minute:
 * - a local copy when the last good one is an hour old;
 * - the off-site copy once a day, when the key and Google Drive are set up (retried hourly
 *   after a failure);
 * - the integrity checks of the live database once after every start of the database (after a
 *   power cut too, M6.2 part I), and every night after 02:00 (Dubai);
 * - the owner's requests (back up now, upload now, restore test, drive copy), oldest first.
 */
import { stat } from 'node:fs/promises';
import type pg from 'pg';
import type { BackupConfig } from './config';
import { inSystemTx } from './db';
import { liveIntegrity, nightlyIntegrity, startCheckDue } from './integrity';
import { localBackup } from './local';
import { offlineCopy } from './offline';
import { ageRecipient, offsiteUpload } from './offsite';
import { restoreTest } from './restore';

const HOUR = 3600 * 1000;

async function lastRunAt(
  client: pg.Client,
  kind: string,
  status: 'success' | 'any',
): Promise<Date | null> {
  const { rows } = await client.query<{ at: Date | null }>(
    `SELECT max(finished_at) AS at FROM ops.backup_runs
      WHERE kind = $1 AND ($2 = 'any' OR status = 'success')`,
    [kind, status],
  );
  return rows[0]?.at ?? null;
}

const olderThan = (at: Date | null, ms: number, now: Date) =>
  at === null || now.getTime() - at.getTime() >= ms;

async function offsiteReady(client: pg.Client, config: BackupConfig): Promise<boolean> {
  if (!(await ageRecipient(client))) return false;
  return (await stat(config.driveCredentialsFile).catch(() => null)) !== null;
}

async function markRequest(
  client: pg.Client,
  id: string,
  status: 'running' | 'done' | 'failed',
  error?: unknown,
): Promise<void> {
  const message =
    error === undefined
      ? null
      : (error instanceof Error ? error.message : 'failed').slice(0, 2000) || 'failed';
  await inSystemTx(client, `backup request ${status}`, () =>
    client.query(`UPDATE ops.backup_requests SET status = $2, error_message = $3 WHERE id = $1`, [
      id,
      status,
      message,
    ]),
  );
}

/** The owner's waiting requests, oldest first, each in turn. */
export async function processRequests(client: pg.Client, config: BackupConfig): Promise<number> {
  const { rows } = await client.query<{ id: string; kind: string; target: string | null }>(
    `SELECT id::text, kind, target FROM ops.backup_requests WHERE status = 'pending' ORDER BY id`,
  );
  for (const request of rows) {
    await markRequest(client, request.id, 'running');
    try {
      const requestId = request.id;
      if (request.kind === 'backup_now') await localBackup(client, config, { requestId });
      else if (request.kind === 'offsite_now') await offsiteUpload(client, config, { requestId });
      else if (request.kind === 'restore_test') {
        const result = await restoreTest(client, config, { requestId });
        if (!result.ok) throw new Error('The restore test found problems');
      } else if (request.kind === 'offline_copy') {
        await offlineCopy(client, config, { target: request.target!, requestId });
      }
      await markRequest(client, request.id, 'done');
    } catch (error) {
      await markRequest(client, request.id, 'failed', error);
    }
  }
  return rows.length;
}

/** The Dubai date and hour now (the business runs on Dubai time, golden rule 8). */
function dubai(now: Date): { date: string; hour: number } {
  const local = new Date(now.getTime() + 4 * HOUR);
  return { date: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
}

/** One pass of the schedule. Each job's failure is recorded in its run; the pass goes on. */
export async function tick(
  client: pg.Client,
  config: BackupConfig,
  now = new Date(),
  options: { nightlyFromHour?: number } = {},
): Promise<string[]> {
  const done: string[] = [];
  const attempt = async (name: string, job: () => Promise<unknown>) => {
    try {
      await job();
      done.push(name);
    } catch {
      done.push(`${name} (failed)`);
    }
  };
  await processRequests(client, config);
  if (await startCheckDue(client)) {
    await attempt('start-check', () => liveIntegrity(client, 'after_start'));
  }
  if (olderThan(await lastRunAt(client, 'logical_dump', 'success'), HOUR, now)) {
    await attempt('local', () => localBackup(client, config, { now }));
  }
  if (
    (await offsiteReady(client, config)) &&
    olderThan(await lastRunAt(client, 'offsite_upload', 'success'), 24 * HOUR, now) &&
    olderThan(await lastRunAt(client, 'offsite_upload', 'any'), HOUR, now)
  ) {
    await attempt('offsite', () => offsiteUpload(client, config, { now }));
  }
  const { date, hour } = dubai(now);
  if (hour >= (options.nightlyFromHour ?? 2)) {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.integrity_runs
        WHERE run_kind = 'nightly' AND (started_at AT TIME ZONE 'Asia/Dubai')::date = $1::date`,
      [date],
    );
    if (rows[0]!.n === 0) await attempt('integrity', () => nightlyIntegrity(client));
  }
  return done;
}
