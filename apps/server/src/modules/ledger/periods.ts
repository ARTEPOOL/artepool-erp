/**
 * Monthly accounting periods (decisions 0016, 0035): open → closed → locked, in month order.
 * The database decides every step; the server only asks for it and keeps months 3 ahead.
 */
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { PeriodItem, PeriodStatus, PeriodsResponse } from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { withBusinessTx } from '../../platform/db/tx';
import { expectUpdated } from '../../platform/db/versioned';
import { AppError } from '../../platform/errors/app-error';

const MONTHS_AHEAD = 3;

export async function listPeriods(db: Kysely<DB>): Promise<PeriodsResponse> {
  const rows = await db
    .selectFrom('gl.periods as p')
    .leftJoin('auth.users as c', 'c.id', 'p.closed_by')
    .leftJoin('auth.users as l', 'l.id', 'p.locked_by')
    .select([
      'p.id',
      'p.period_start',
      'p.period_end',
      'p.fiscal_year',
      'p.status',
      'p.closed_at',
      'p.locked_at',
      'p.row_version',
      'c.display_name_en as closed_by_en',
      'c.display_name_ar as closed_by_ar',
      'l.display_name_en as locked_by_en',
      'l.display_name_ar as locked_by_ar',
    ])
    .orderBy('p.period_start', 'desc')
    .execute();
  const { rows: today } = await sql<{
    d: string;
  }>`SELECT sys.business_date(now())::text AS d`.execute(db);
  return {
    today: today[0]!.d,
    periods: rows.map((r): PeriodItem => ({
      id: r.id.toString(),
      periodStart: String(r.period_start),
      periodEnd: String(r.period_end),
      fiscalYear: r.fiscal_year,
      status: r.status as PeriodStatus,
      closedAt: r.closed_at?.toISOString() ?? null,
      closedByName: r.closed_by_en ?? null,
      lockedAt: r.locked_at?.toISOString() ?? null,
      lockedByName: r.locked_by_en ?? null,
      rowVersion: r.row_version,
    })),
  };
}

async function onePeriod(db: Kysely<DB>, id: bigint): Promise<PeriodItem> {
  const period = (await listPeriods(db)).periods.find((p) => p.id === id.toString());
  if (!period) throw new AppError('NOT_FOUND', 'No such period');
  return period;
}

/** Close, reopen (with the reason in the request context) or lock one month. */
export async function setPeriodStatus(
  trx: Transaction<DB>,
  id: bigint,
  status: PeriodStatus,
  rowVersion: number,
): Promise<PeriodItem> {
  const result = await trx
    .updateTable('gl.periods')
    .set({ status })
    .where('id', '=', id)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'gl.periods', id, result);
  return onePeriod(trx, id);
}

/** Creates the missing months up to 3 ahead, as SYSTEM (decision 0016). Returns how many. */
export async function ensurePeriods(db: Kysely<DB>): Promise<number> {
  return withBusinessTx(
    db,
    { userId: 1n, requestId: randomUUID(), reason: 'automatic: months kept 3 ahead' },
    async (trx) => {
      const { rows } = await sql<{ created: number }>`
        SELECT gl.ensure_periods(${MONTHS_AHEAD}) AS created`.execute(trx);
      return rows[0]!.created;
    },
  );
}
