/**
 * The server clock guard (M6.2 part C, migration 0043). The database refuses any write whose
 * server time is more than 2 minutes before the latest record (CLOCK_BACKWARDS); this check, run
 * every few minutes by the server, tells the owner with a "server clock went back" alert (one per
 * day while it lasts). Correcting the Windows time fixes it.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '../db/pool';
import { withBusinessTx } from '../db/tx';
import { dubaiDate } from './index';

export interface ClockStatus {
  serverTime: Date;
  latestRecordAt: Date | null;
  isBehind: boolean;
}

export async function clockStatus(db: Db): Promise<ClockStatus> {
  const { rows } = await sql<{
    server_time: Date;
    latest_record_at: Date | null;
    is_behind: boolean;
  }>`SELECT server_time, latest_record_at, is_behind FROM sys.clock_status()`.execute(db);
  const row = rows[0]!;
  return {
    serverTime: row.server_time,
    latestRecordAt: row.latest_record_at,
    isBehind: row.is_behind,
  };
}

/** Raises the alert when the clock is behind; returns the status either way. */
export async function raiseClockAlert(db: Db): Promise<ClockStatus> {
  const status = await clockStatus(db);
  if (!status.isBehind) return status;
  // The latest record's day: the server's own day cannot be trusted while its clock is wrong.
  const day = dubaiDate(status.latestRecordAt!);
  await withBusinessTx(
    db,
    { userId: 1n, requestId: randomUUID(), reason: 'server clock check' },
    async (trx) => {
      await sql`INSERT INTO sys.alerts (alert_type, severity, params, dedupe_key)
                VALUES ('clock_backwards', 'critical',
                        ${JSON.stringify({
                          serverTime: status.serverTime.toISOString(),
                          latestRecordAt: status.latestRecordAt!.toISOString(),
                        })}::jsonb,
                        ${`clock_backwards:${day}`})
                ON CONFLICT (dedupe_key) WHERE acknowledged_at IS NULL DO NOTHING`.execute(trx);
    },
  );
  return status;
}
