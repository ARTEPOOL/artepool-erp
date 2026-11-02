/**
 * Automatic online updates in System health (decision 0108): what the server PC's updater keeps
 * in ops.update_state, the owner's "Check now" (0110, read by the server itself since 0115),
 * "Install now" (the updater is woken at once, 0115) and the night window. Owner only.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  isNewerVersion,
  type UpdateResult,
  type UpdateStatus,
  type UpdateWindowBody,
} from '@artepool/shared/contracts';
import { latestSchema, type Latest } from '../../cli/updater/steps';
import { AppError } from '../../platform/errors/app-error';
import type { DB } from '../../platform/db/schema.generated';

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export async function updateStatus(db: Kysely<DB>): Promise<UpdateStatus> {
  const state = await db
    .selectFrom('ops.update_state')
    .selectAll()
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  const request = await db
    .selectFrom('ops.update_requests')
    .select(['version', 'status'])
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const requested = state.check_requested_at;
  return {
    currentVersion: state.current_version,
    checkedAt: iso(state.checked_at),
    checkError: state.check_error,
    checking:
      requested !== null && (!state.checked_at || requested.getTime() > state.checked_at.getTime()),
    available:
      state.available_version && isNewerVersion(state.available_version, state.current_version)
        ? {
            version: state.available_version,
            notesAr: state.notes_ar,
            notesEn: state.notes_en,
            publishedAt: iso(state.published_at),
          }
        : null,
    downloadStatus: state.download_status as UpdateStatus['downloadStatus'],
    waitingReason: state.waiting_reason as UpdateStatus['waitingReason'],
    lastResult: (state.last_result as UpdateResult | null) ?? null,
    window: { startHour: state.window_start_hour, endHour: state.window_end_hour },
    request: request
      ? {
          version: request.version,
          status: request.status as 'pending' | 'running' | 'done' | 'failed',
        }
      : null,
    progress:
      state.download_bytes !== null && state.progress_at
        ? {
            receivedBytes: Number(state.download_bytes),
            totalBytes: state.download_total === null ? null : Number(state.download_total),
            bytesPerSecond: Number(state.download_rate ?? 0),
            at: state.progress_at.toISOString(),
          }
        : null,
  };
}

/** "Install now": the downloaded, checked version; the updater is woken and starts at once (0115). */
export async function installNow(trx: Transaction<DB>): Promise<{ version: string }> {
  const state = await trx
    .selectFrom('ops.update_state')
    .select(['available_version', 'download_status', 'current_version'])
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  if (
    !state.available_version ||
    state.download_status !== 'ready' ||
    !isNewerVersion(state.available_version, state.current_version)
  ) {
    throw new AppError('UPDATE_NOT_AVAILABLE', 'There is no downloaded update to install');
  }
  const open = await trx
    .selectFrom('ops.update_requests')
    .select('id')
    .where('status', 'in', ['pending', 'running'])
    .executeTakeFirst();
  if (open) throw new AppError('UPDATE_REQUEST_OPEN', 'The update is already waiting');
  await trx
    .insertInto('ops.update_requests')
    .values({ version: state.available_version } as never)
    .execute();
  return { version: state.available_version };
}

/** What the server found when it read the update list itself (0115). */
export type ListRead = { latest: Latest } | { error: string };

/** Reads the update list before the transaction (0115); no internet is an answer, not an error. */
export async function readUpdateList(fetchLatest: () => Promise<unknown>): Promise<ListRead> {
  try {
    return { latest: latestSchema.parse(await fetchLatest()) };
  } catch (error) {
    return { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
  }
}

/**
 * "Check now" (0110, 0115): the owner's request and, when the server reached the update list,
 * what it says, in one transaction; the updater is then woken and downloads a newer version at
 * once. When the server could not reach it, the request stays open for the updater to read it.
 */
export async function checkNow(
  trx: Transaction<DB>,
  read: ListRead,
): Promise<{ ok: true; available: string | null; error: string | null }> {
  const state = await trx
    .selectFrom('ops.update_state')
    .select('current_version')
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  if ('error' in read) {
    await trx
      .updateTable('ops.update_state')
      .set({ check_requested_at: sql<Date>`now()` })
      .where('id', '=', 1)
      .execute();
    return { ok: true, available: null, error: read.error };
  }
  const { latest } = read;
  const newer = !state.current_version || isNewerVersion(latest.version, state.current_version);
  await trx
    .updateTable('ops.update_state')
    .set({
      check_requested_at: sql<Date>`now()`,
      checked_at: sql<Date>`now()`,
      check_error: null,
      available_version: newer ? latest.version : null,
      notes_ar: newer ? latest.notesAr : null,
      notes_en: newer ? latest.notesEn : null,
      published_at: newer && latest.pub_date ? new Date(latest.pub_date) : null,
    })
    .where('id', '=', 1)
    .execute();
  return { ok: true, available: newer ? latest.version : null, error: null };
}

export async function setWindow(trx: Transaction<DB>, body: UpdateWindowBody): Promise<void> {
  await trx
    .updateTable('ops.update_state')
    .set({ window_start_hour: body.startHour, window_end_hour: body.endHour })
    .where('id', '=', 1)
    .execute();
}
