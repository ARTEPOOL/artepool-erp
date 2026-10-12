/**
 * Stock counts (CNT-, decision 0044). Starting a count freezes the system quantities; while
 * counting, the people counting never see them (blind count). On posting, each difference is
 * counted − (frozen + moved since the count started), needs a reason, and becomes a movement;
 * one journal entry carries the whole count (posting map row 13).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { quantityFromDb, quantityToDb } from '@artepool/shared';
import type {
  CountDetail,
  CountItem,
  CountLine,
  CountsResponse,
  CreateCountRequest,
  PostCountRequest,
  SaveCountLinesRequest,
  StockStatus,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { assertVersion, fieldError } from '../../platform/db/versioned';
import { AppError, ruleError } from '../../platform/errors/app-error';
import { requireAlso } from '../../platform/permissions';
import { consumeApproval } from '../approvals/service';
import { postEntry } from '../ledger/posting';
import { stockPosting } from '../ledger/stock-posting';
import {
  addMovement,
  canSeeValues,
  incomingCost,
  today,
  valueOf,
  warehouseOf,
  type Auth,
} from './service';

type Db = Kysely<DB> | Transaction<DB>;

const canReview = (auth: Auth) => auth?.permissions.has('stock.count_post') ?? false;

export async function createCount(trx: Transaction<DB>, body: CreateCountRequest): Promise<bigint> {
  const warehouseId = await warehouseOf(trx, body.warehouseId);
  const count = await trx
    .insertInto('inv.counts')
    .values(
      stamped('inv.counts', {
        warehouse_id: warehouseId,
        status: 'counting',
        scope: body.scope,
        category_id: body.categoryId ? BigInt(body.categoryId) : null,
        note: body.note ?? null,
      } as never),
    )
    .returning('id')
    .executeTakeFirstOrThrow();

  // The items in scope, with their sellable quantity frozen now (same transaction as the snapshot).
  let items = trx
    .selectFrom('md.items as i')
    .leftJoin('inv.balances as b', (join) =>
      join
        .onRef('b.item_id', '=', 'i.id')
        .on('b.warehouse_id', '=', warehouseId)
        .on('b.stock_status', '=', 'available'),
    )
    .select(['i.id', sql<string>`coalesce(b.quantity, 0)`.as('qty')])
    .where('i.item_type', '=', 'stock')
    .where('i.is_active', '=', true);
  if (body.scope === 'category') {
    const root = BigInt(body.categoryId!);
    items = items.where(
      'i.category_id',
      'in',
      sql<bigint>`(WITH RECURSIVE tree AS (
          SELECT id FROM md.item_categories WHERE id = ${root}
          UNION ALL SELECT c.id FROM md.item_categories c JOIN tree ON c.parent_id = tree.id)
        SELECT id FROM tree)`,
    );
  }
  if (body.scope === 'selected') items = items.where('i.id', 'in', body.itemIds!.map(BigInt));
  const rows = await items.orderBy('i.code').execute();
  if (rows.length === 0) throw fieldError('itemIds', 'required');
  await trx
    .insertInto('inv.count_lines')
    .values(
      rows.map((r) =>
        stamped('inv.count_lines', { count_id: count.id, item_id: r.id, system_qty: r.qty }),
      ),
    )
    .execute();
  return count.id;
}

function countBase(db: Db) {
  return db
    .selectFrom('inv.counts as c')
    .select([
      'c.id',
      'c.doc_number',
      'c.status',
      'c.scope',
      'c.category_id',
      'c.warehouse_id',
      'c.snapshot_at',
      'c.count_date',
      'c.note',
      'c.posted_at',
      'c.created_at',
      'c.total_value_fils',
      'c.row_version',
      sql<number>`(SELECT count(*)::int FROM inv.count_lines l WHERE l.count_id = c.id)`.as(
        'line_count',
      ),
      sql<number>`(SELECT count(*)::int FROM inv.count_lines l WHERE l.count_id = c.id AND l.counted_qty IS NOT NULL)`.as(
        'counted_lines',
      ),
    ]);
}

type CountRow = Awaited<ReturnType<ReturnType<typeof countBase>['executeTakeFirstOrThrow']>>;

function countItem(r: CountRow, showValues: boolean): CountItem {
  return {
    id: r.id.toString(),
    docNumber: r.doc_number,
    status: r.status as CountItem['status'],
    scope: r.scope as CountItem['scope'],
    categoryId: r.category_id?.toString() ?? null,
    warehouseId: r.warehouse_id.toString(),
    snapshotAt: r.snapshot_at?.toISOString() ?? null,
    countDate: r.count_date,
    note: r.note,
    lineCount: r.line_count,
    countedLines: r.counted_lines,
    postedAt: r.posted_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    rowVersion: r.row_version,
    ...(showValues ? { totalValueFils: r.total_value_fils?.toString() ?? null } : {}),
  };
}

export async function listCounts(
  db: Db,
  auth: Auth,
  page: number,
  pageSize: number,
): Promise<CountsResponse> {
  const total = await db
    .selectFrom('inv.counts')
    .select(sql<number>`count(*)::int`.as('n'))
    .executeTakeFirstOrThrow();
  const rows = await countBase(db)
    .orderBy('c.id', 'desc')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();
  return { total: total.n, counts: rows.map((r) => countItem(r, canSeeValues(auth))) };
}

/** Quantities moved in each line's item and status since the count started (other documents only). */
async function movedSince(db: Db, countId: bigint): Promise<Map<string, bigint>> {
  const rows = await db
    .selectFrom('inv.count_lines as l')
    .innerJoin('inv.counts as c', 'c.id', 'l.count_id')
    .innerJoin('inv.movements as m', (join) =>
      join
        .onRef('m.item_id', '=', 'l.item_id')
        .onRef('m.warehouse_id', '=', 'c.warehouse_id')
        .onRef('m.stock_status', '=', 'l.stock_status')
        .onRef('m.occurred_at', '>', 'c.snapshot_at'),
    )
    .select(['l.id', sql<string>`sum(m.quantity)`.as('moved')])
    .where('l.count_id', '=', countId)
    .where(sql<boolean>`m.count_line_id IS DISTINCT FROM l.id`)
    .groupBy('l.id')
    .execute();
  return new Map(rows.map((r) => [r.id.toString(), quantityFromDb(r.moved)]));
}

export async function getCount(db: Db, auth: Auth, id: bigint): Promise<CountDetail> {
  const row = await countBase(db).where('c.id', '=', id).executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'No such count');
  const showValues = canSeeValues(auth);
  // Blind count: the system quantities are for the reviewer only (stock.count_post).
  const review = canReview(auth) && row.status !== 'cancelled';
  const lines = await db
    .selectFrom('inv.count_lines as l')
    .innerJoin('md.items as i', 'i.id', 'l.item_id')
    .select([
      'l.id',
      'l.item_id',
      'i.code',
      'i.name_ar',
      'i.name_en',
      'i.unit_id',
      'l.stock_status',
      'l.system_qty',
      'l.counted_qty',
      'l.counted_by',
      'l.counted_at',
      'l.reason_code_id',
      'l.note',
      'l.movement_since_snapshot',
      'l.variance_qty',
      'l.value_fils',
    ])
    .where('l.count_id', '=', id)
    .orderBy('i.code')
    .execute();
  const moved =
    review && row.status === 'counting' ? await movedSince(db, id) : new Map<string, bigint>();
  return {
    ...countItem(row, showValues),
    review,
    lines: lines.map((l): CountLine => {
      const base: CountLine = {
        id: l.id.toString(),
        itemId: l.item_id.toString(),
        itemCode: l.code,
        nameAr: l.name_ar,
        nameEn: l.name_en,
        unitId: l.unit_id.toString(),
        stockStatus: l.stock_status as StockStatus,
        countedMilli: l.counted_qty === null ? null : quantityFromDb(l.counted_qty).toString(),
        countedBy: l.counted_by?.toString() ?? null,
        countedAt: l.counted_at?.toISOString() ?? null,
        reasonCodeId: l.reason_code_id?.toString() ?? null,
        note: l.note,
      };
      if (!review) return base;
      const system = quantityFromDb(l.system_qty);
      const since =
        l.movement_since_snapshot !== null
          ? quantityFromDb(l.movement_since_snapshot)
          : (moved.get(l.id.toString()) ?? 0n);
      const variance =
        l.variance_qty !== null
          ? quantityFromDb(l.variance_qty)
          : l.counted_qty === null
            ? null
            : quantityFromDb(l.counted_qty) - (system + since);
      return {
        ...base,
        systemMilli: system.toString(),
        movedSinceMilli: since.toString(),
        ...(variance !== null ? { varianceMilli: variance.toString() } : {}),
        ...(showValues && l.value_fils !== null ? { varianceFils: l.value_fils.toString() } : {}),
      };
    }),
  };
}

/** Saves counted quantities (null clears one) while the count is open. */
export async function saveCountLines(
  trx: Transaction<DB>,
  id: bigint,
  body: SaveCountLinesRequest,
): Promise<void> {
  const count = await trx
    .selectFrom('inv.counts')
    .select('status')
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (!count) throw new AppError('NOT_FOUND', 'No such count');
  if (count.status !== 'counting') throw ruleError('DOCUMENT_STEP', 'The count is not open');
  for (const l of body.lines) {
    const result = await trx
      .updateTable('inv.count_lines')
      .set({ counted_qty: l.countedMilli === null ? null : quantityToDb(BigInt(l.countedMilli)) })
      .where('id', '=', BigInt(l.lineId))
      .where('count_id', '=', id)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw fieldError('lines', 'unknown');
  }
}

export async function postCount(
  trx: Transaction<DB>,
  auth: Auth,
  id: bigint,
  body: PostCountRequest,
): Promise<CountDetail> {
  requireAlso(auth, 'stock.count_post');
  const count = await trx
    .selectFrom('inv.counts')
    .select(['status', 'warehouse_id', 'row_version'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (!count) throw new AppError('NOT_FOUND', 'No such count');
  await assertVersion(trx, 'inv.counts', id, body.rowVersion);
  if (count.status !== 'counting') throw ruleError('DOCUMENT_STEP', 'The count is not open');
  const date = body.date ?? (await today(trx));
  const reasons = new Map(body.reasons.map((r) => [r.lineId, r]));
  const allowed = new Set(
    (
      await trx
        .selectFrom('sys.reason_codes')
        .select('id')
        .where('category', '=', 'stock_count')
        .where('is_active', '=', true)
        .execute()
    ).map((r) => r.id.toString()),
  );
  const lines = await trx
    .selectFrom('inv.count_lines')
    .select(['id', 'item_id', 'stock_status', 'system_qty', 'counted_qty'])
    .where('count_id', '=', id)
    .execute();
  // The expected quantity is the current balance, read under its lock: a sale committing at the
  // same moment is then neither counted twice nor missed. "Moved since" is kept for the record.
  const current = new Map<string, bigint>();
  for (const status of new Set(lines.map((l) => l.stock_status))) {
    const locked = await sql<{ item_id: string; quantity: string }>`
      SELECT item_id::text, quantity::text FROM inv.lock_balances(${count.warehouse_id}, ${status},
        ${lines.filter((l) => l.stock_status === status).map((l) => l.item_id.toString())}::bigint[])`.execute(
      trx,
    );
    for (const b of locked.rows) current.set(`${status}:${b.item_id}`, quantityFromDb(b.quantity));
  }

  const movements: { stockStatus: string; valueFils: bigint }[] = [];
  let net = 0n;
  let absolute = 0n;
  for (const l of lines) {
    if (l.counted_qty === null) throw ruleError('COUNT_INCOMPLETE', 'Not every line is counted');
    const expected = current.get(`${l.stock_status}:${l.item_id.toString()}`) ?? 0n;
    const since = expected - quantityFromDb(l.system_qty);
    const variance = quantityFromDb(l.counted_qty) - expected;
    const reason = reasons.get(l.id.toString());
    if (variance !== 0n && (!reason || !allowed.has(reason.reasonCodeId))) {
      throw new AppError('VALIDATION_FAILED', 'A difference needs a reason', {
        part: 'body',
        issues: [{ path: ['reasons', l.id.toString()], code: 'required' }],
      });
    }
    let fils = 0n;
    if (variance !== 0n) {
      let value4dp: bigint | undefined;
      if (variance > 0n) {
        const cost = await incomingCost(trx, l.item_id, count.warehouse_id, false);
        if (cost === null) {
          throw ruleError('COST_UNKNOWN', 'This item has no cost', {
            itemId: l.item_id.toString(),
          });
        }
        value4dp = valueOf(variance, cost);
      }
      const m = await addMovement(trx, {
        type: variance > 0n ? 'count_gain' : 'count_loss',
        date,
        itemId: l.item_id,
        warehouseId: count.warehouse_id,
        status: l.stock_status as StockStatus,
        quantityMilli: variance,
        ...(value4dp !== undefined ? { value4dp } : {}),
        countLineId: l.id,
      });
      fils = m.valueFils;
      movements.push({ stockStatus: l.stock_status, valueFils: fils });
      net += fils;
      absolute += fils < 0n ? -fils : fils;
    }
    await trx
      .updateTable('inv.count_lines')
      .set({
        movement_since_snapshot: quantityToDb(since),
        variance_qty: quantityToDb(variance),
        value_fils: fils,
        reason_code_id: variance !== 0n ? BigInt(reason!.reasonCodeId) : null,
        note: reason?.note ?? null,
      })
      .where('id', '=', l.id)
      .execute();
  }
  if (body.approvalId) {
    const approved = await consumeApproval(
      trx,
      BigInt(body.approvalId),
      'stock.adjust_over_threshold',
      `inv.counts:${id}`,
    );
    // The approval is for this count only (decision 0041).
    if (approved.action !== 'stock_count' || approved.countId !== id.toString()) {
      throw new AppError('APPROVAL_INVALID', 'The approval was given for a different count');
    }
  }
  await trx
    .updateTable('inv.counts')
    .set({
      status: 'posted',
      count_date: date,
      total_value_fils: net,
      variance_abs_fils: absolute,
      approval_id: body.approvalId ? BigInt(body.approvalId) : null,
    })
    .where('id', '=', id)
    .execute();
  await postEntry(trx, {
    date,
    source: { type: 'inventory_count', id },
    amounts: stockPosting('count', movements),
  });
  return getCount(trx, auth, id);
}

export async function cancelCount(
  trx: Transaction<DB>,
  id: bigint,
  rowVersion: number,
): Promise<void> {
  const result = await trx
    .updateTable('inv.counts')
    .set({ status: 'cancelled' })
    .where('id', '=', id)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) await assertVersion(trx, 'inv.counts', id, rowVersion);
}
