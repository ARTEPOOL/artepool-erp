/**
 * Automatic online updates in System health (decision 0108): what the server PC's updater keeps
 * in ops.update_state, the owner's "Install now" and the night window. Owner only.
 */
import type { Kysely, Transaction } from 'kysely';
import type { UpdateResult, UpdateStatus, UpdateWindowBody } from '@artepool/shared/contracts';
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
  return {
    currentVersion: state.current_version,
    checkedAt: iso(state.checked_at),
    checkError: state.check_error,
    available: state.available_version
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
    .select(['available_version', 'download_status'])
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  if (!state.available_version || state.download_status !== 'ready') {
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

export async function setWindow(trx: Transaction<DB>, body: UpdateWindowBody): Promise<void> {
  await trx
    .updateTable('ops.update_state')
    .set({ window_start_hour: body.startHour, window_end_hour: body.endHour })
    .where('id', '=', 1)
    .execute();
}
