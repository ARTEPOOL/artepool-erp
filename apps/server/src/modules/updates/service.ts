/**
 * Automatic online updates in System health (decision 0108): what the server PC's updater keeps
 * in ops.update_state, the owner's "Check now" (0110), "Install now" and the night window. Owner
 * only.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  isNewerVersion,
  type UpdateResult,
  type UpdateStatus,
  type UpdateWindowBody,
} from '@artepool/shared/contracts';
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
  };
}

/** "Install now": the downloaded, checked version; installed within minutes if no shift is open. */
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

/** "Check now" (0110): the server PC's updater reads the update list on its next run (≤ 5 minutes). */
export async function checkNow(trx: Transaction<DB>): Promise<{ ok: true }> {
  await trx
    .updateTable('ops.update_state')
    .set({ check_requested_at: sql<Date>`now()` })
    .where('id', '=', 1)
    .execute();
  return { ok: true };
}

export async function setWindow(trx: Transaction<DB>, body: UpdateWindowBody): Promise<void> {
  await trx
    .updateTable('ops.update_state')
    .set({ window_start_hour: body.startHour, window_end_hour: body.endHour })
    .where('id', '=', 1)
    .execute();
}
