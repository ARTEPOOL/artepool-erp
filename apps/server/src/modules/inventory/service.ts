/**
 * Stock adjustments (ADJ-), the item stock card, the stock tiles and oversell reviews. Every
 * adjustment is one transaction: the document, its lines, the movements (valued by the database),
 * the journal entry and the audit (golden rule 4). Values are shown only with stock.view_cost
 * (decision 0040); a large change needs a supervisor's approval (0041); opening stock is the
 * owner's (0042).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { quantityFromDb, quantityToDb, roundDiv } from '@artepool/shared';
import type {
  AdjustmentDetail,
  AdjustmentItem,
  AdjustmentKind,
  AdjustmentsQuery,
  AdjustmentsResponse,
  CreateAdjustmentRequest,
  ItemStockResponse,
  MovementType,
  ReviewOversellRequest,
  StockStatus,
  StockSummary,
  PersonName,
} from '@artepool/shared/contracts';
import { ADJUSTMENT_PERMISSION } from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { expectUpdated, fieldError } from '../../platform/db/versioned';
import { AppError, ruleError } from '../../platform/errors/app-error';
import { requireAlso } from '../../platform/permissions';
import { consumeApproval } from '../approvals/service';
import { postEntry } from '../ledger/posting';
import { stockPosting } from '../ledger/stock-posting';

export type Auth = { permissions: ReadonlySet<string> } | null;
type Db = Kysely<DB> | Transaction<DB>;

export const canSeeValues = (auth: Auth): boolean =>
  auth?.permissions.has('stock.view_cost') ?? false;

/** The business date in Al Ain. */
export async function today(db: Db): Promise<string> {
  const { rows } = await sql<{ d: string }>`SELECT sys.business_date(now())::text AS d`.execute(db);
  return rows[0]!.d;
}

/** The warehouse a document uses: the one asked for, else the default one. */
export async function warehouseOf(db: Db, id: string | undefined): Promise<bigint> {
  let q = db.selectFrom('md.warehouses').select('id').where('is_active', '=', true);
  q = id ? q.where('id', '=', BigInt(id)) : q.where('is_default', '=', true);
  const row = await q.executeTakeFirst();
  if (!row) throw fieldError('warehouseId', 'unknown');
  return row.id;
}

/**
 * What one incoming unit is worth when nobody typed it: the current average in this warehouse,
 * else the last known average, else the item's purchase price (decision 0038).
 */
export async function incomingCost(
  db: Db,
  itemId: bigint,
  warehouseId: bigint,
  opening: boolean,
): Promise<bigint | null> {
  if (!opening) {
    const balance = await db
      .selectFrom('inv.balances')
      .select('avg_unit_cost_4dp')
      .where('item_id', '=', itemId)
      .where('warehouse_id', '=', warehouseId)
      .where('stock_status', '=', 'available')
      .executeTakeFirst();
    if (balance?.avg_unit_cost_4dp != null) return balance.avg_unit_cost_4dp;
  }
  const item = await db
    .selectFrom('md.items')
    .select('fallback_unit_cost_4dp')
    .where('id', '=', itemId)
    .executeTakeFirst();
  return item?.fallback_unit_cost_4dp ?? null;
}

/** qty (thousandths) × unit cost (4 dp) → value in 4 dp, rounded once by the shared helper. */
export const valueOf = (quantityMilli: bigint, unitCost4dp: bigint): bigint =>
  roundDiv(quantityMilli * unitCost4dp, 1000n);

const INBOUND: ReadonlySet<AdjustmentKind> = new Set(['opening', 'increase', 'oversell']);

const MOVEMENT_OF: Record<Exclude<AdjustmentKind, 'status_change'>, MovementType> = {
  opening: 'opening',
  increase: 'adjustment_in',
  decrease: 'adjustment_out',
  write_off: 'write_off',
  oversell: 'oversell_in',
};

/** Inserts one movement; the database values outgoing stock and refuses stock below zero. */
export async function addMovement(
  trx: Transaction<DB>,
  m: {
    type: MovementType;
    date: string;
    itemId: bigint;
    warehouseId: bigint;
    status: StockStatus;
    quantityMilli: bigint;
    value4dp?: bigint;
    adjustmentLineId?: bigint;
    countLineId?: bigint;
    salesDocumentLineId?: bigint;
  },
): Promise<{ value4dp: bigint; valueFils: bigint }> {
  const row = await trx
    .insertInto('inv.movements')
    .values(
      stamped('inv.movements', {
        movement_type: m.type,
        movement_date: m.date,
        item_id: m.itemId,
        warehouse_id: m.warehouseId,
        stock_status: m.status,
        quantity: quantityToDb(m.quantityMilli),
        // Outgoing values are always computed by the database.
        value_4dp: m.value4dp ?? (null as unknown as bigint),
        adjustment_line_id: m.adjustmentLineId ?? null,
        count_line_id: m.countLineId ?? null,
        sales_document_line_id: m.salesDocumentLineId ?? null,
      } as never),
    )
    .returning(['value_4dp', 'value_fils'])
    .executeTakeFirstOrThrow();
  return { value4dp: row.value_4dp, valueFils: row.value_fils };
}

// ---------------------------------------------------------------------------------------------
// Creating and posting an adjustment
// ---------------------------------------------------------------------------------------------

export async function createAdjustment(
  trx: Transaction<DB>,
  auth: Auth,
  body: CreateAdjustmentRequest,
  importBatchId: bigint | null = null,
): Promise<AdjustmentDetail> {
  requireAlso(auth, ADJUSTMENT_PERMISSION[body.kind]);
  if (body.lines.some((l) => l.unitCost4dp !== undefined) && !canSeeValues(auth)) {
    // Only someone who may see costs may type one (decision 0040).
    requireAlso(auth, 'stock.view_cost');
  }
  const warehouseId = await warehouseOf(trx, body.warehouseId);
  const date = body.date ?? (await today(trx));
  const reason = await trx
    .selectFrom('sys.reason_codes')
    .select(['requires_note', 'is_active'])
    .where('id', '=', BigInt(body.reasonCodeId))
    .executeTakeFirst();
  if (!reason?.is_active) throw fieldError('reasonCodeId', 'unknown');
  if (reason.requires_note && !body.note) throw fieldError('note', 'required');
  const ids = body.lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) throw fieldError('lines', 'duplicate');

  const doc = await trx
    .insertInto('inv.adjustments')
    .values(
      stamped('inv.adjustments', {
        kind: body.kind,
        warehouse_id: warehouseId,
        adjustment_date: date,
        reason_code_id: BigInt(body.reasonCodeId),
        note: body.note ?? null,
        approval_id: body.approvalId ? BigInt(body.approvalId) : null,
        import_batch_id: importBatchId,
      } as never),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  if (body.approvalId) {
    const approved = await consumeApproval(
      trx,
      BigInt(body.approvalId),
      'stock.adjust_over_threshold',
      `inv.adjustments:${doc.id}`,
    );
    assertApprovalFits(approved, body);
  }

  const movements: { stockStatus: string; valueFils: bigint }[] = [];
  let total = 0n;
  for (const [i, l] of body.lines.entries()) {
    const itemId = BigInt(l.itemId);
    const qty = BigInt(l.quantityMilli);
    const inbound = INBOUND.has(body.kind);
    const from: StockStatus =
      body.kind === 'write_off' ? 'defective' : (l.stockStatus ?? 'available');
    const target: StockStatus | null =
      body.kind === 'status_change'
        ? (l.targetStatus ?? (from === 'available' ? 'defective' : 'available'))
        : null;
    let cost: bigint | null = null;
    if (inbound) {
      cost =
        l.unitCost4dp !== undefined
          ? BigInt(l.unitCost4dp)
          : await incomingCost(trx, itemId, warehouseId, body.kind === 'opening');
      if (cost === null) {
        throw ruleError('COST_UNKNOWN', 'This item has no cost', { line: i + 1, itemId: l.itemId });
      }
    }
    const line = await trx
      .insertInto('inv.adjustment_lines')
      .values(
        stamped('inv.adjustment_lines', {
          adjustment_id: doc.id,
          line_no: i + 1,
          item_id: itemId,
          stock_status: from,
          target_status: target,
          quantity: quantityToDb(qty),
          entered_unit_cost_4dp: cost,
          note: l.note ?? null,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    let lineValue4dp: bigint;
    let lineFils: bigint;
    if (body.kind === 'status_change') {
      const out = await addMovement(trx, {
        type: 'status_out',
        date,
        itemId,
        warehouseId,
        status: from,
        quantityMilli: -qty,
        adjustmentLineId: line.id,
      });
      const back = await addMovement(trx, {
        type: 'status_in',
        date,
        itemId,
        warehouseId,
        status: target!,
        quantityMilli: qty,
        value4dp: -out.value4dp,
        adjustmentLineId: line.id,
      });
      movements.push({ stockStatus: from, valueFils: out.valueFils });
      movements.push({ stockStatus: target!, valueFils: back.valueFils });
      lineValue4dp = -out.value4dp;
      lineFils = back.valueFils;
    } else {
      const m = await addMovement(trx, {
        type: MOVEMENT_OF[body.kind],
        date,
        itemId,
        warehouseId,
        status: from,
        quantityMilli: inbound ? qty : -qty,
        ...(inbound ? { value4dp: valueOf(qty, cost!) } : {}),
        adjustmentLineId: line.id,
      });
      movements.push({ stockStatus: from, valueFils: m.valueFils });
      lineValue4dp = m.value4dp;
      lineFils = m.valueFils;
    }
    await trx
      .updateTable('inv.adjustment_lines')
      .set({ value_4dp: lineValue4dp, value_fils: lineFils })
      .where('id', '=', line.id)
      .execute();
    total += lineFils;
  }

  // Posting numbers the document and applies the approval and opening-stock rules.
  await trx
    .updateTable('inv.adjustments')
    .set({ status: 'posted', total_value_fils: total })
    .where('id', '=', doc.id)
    .execute();
  await postEntry(trx, {
    date,
    source: { type: 'inventory_adjustment', id: doc.id },
    amounts: stockPosting(body.kind, movements),
  });
  return getAdjustment(trx, auth, doc.id);
}

/**
 * An approval is for one exact change (decision 0041): the supervisor approved this kind, these
 * items and these quantities. Anything else is refused, so an approval cannot be reused for a
 * bigger or different change.
 */
function assertApprovalFits(context: Record<string, unknown>, body: CreateAdjustmentRequest) {
  const key = (lines: unknown) =>
    Array.isArray(lines)
      ? lines
          .map(
            (l: { itemId?: unknown; quantityMilli?: unknown }) =>
              `${String(l.itemId)}:${String(l.quantityMilli)}`,
          )
          .sort()
          .join(',')
      : null;
  if (
    context.action !== 'stock_adjustment' ||
    context.kind !== body.kind ||
    key(context.lines) !== key(body.lines)
  ) {
    throw new AppError('APPROVAL_INVALID', 'The approval was given for a different change');
  }
}

// ---------------------------------------------------------------------------------------------
// Reading adjustments
// ---------------------------------------------------------------------------------------------

function adjustmentBase(db: Db) {
  return db
    .selectFrom('inv.adjustments as a')
    .leftJoin('gl.journal_entries as j', (join) =>
      join
        .onRef('j.inventory_adjustment_id', '=', 'a.id')
        .on('j.source_type', '=', 'inventory_adjustment'),
    )
    .leftJoin('auth.users as pu', 'pu.id', 'a.posted_by')
    .leftJoin('auth.users as ru', 'ru.id', 'a.reviewed_by')
    .leftJoin('auth.approvals as ap', 'ap.id', 'a.approval_id')
    .leftJoin('auth.users as au', 'au.id', 'ap.approved_by')
    .select([
      'a.id',
      'a.doc_number',
      'a.kind',
      'a.status',
      'a.warehouse_id',
      'a.adjustment_date',
      'a.reason_code_id',
      'a.note',
      'a.review_status',
      'a.review_note',
      'a.reviewed_by',
      'a.reviewed_at',
      'a.posted_at',
      'a.posted_by',
      'a.total_value_fils',
      'a.row_version',
      'j.id as journal_id',
      'j.entry_number',
      'pu.display_name_ar as posted_by_ar',
      'pu.display_name_en as posted_by_en',
      'ru.display_name_ar as reviewed_by_ar',
      'ru.display_name_en as reviewed_by_en',
      'au.display_name_ar as approved_by_ar',
      'au.display_name_en as approved_by_en',
      sql<number>`(SELECT count(*)::int FROM inv.adjustment_lines l WHERE l.adjustment_id = a.id)`.as(
        'line_count',
      ),
    ]);
}

const personName = (ar: string | null, en: string | null): PersonName | null =>
  ar === null || en === null ? null : { displayNameAr: ar, displayNameEn: en };

type AdjustmentRow = Awaited<
  ReturnType<ReturnType<typeof adjustmentBase>['executeTakeFirstOrThrow']>
>;

function adjustmentItem(r: AdjustmentRow, showValues: boolean): AdjustmentItem {
  return {
    id: r.id.toString(),
    docNumber: r.doc_number,
    kind: r.kind as AdjustmentKind,
    status: r.status as AdjustmentItem['status'],
    warehouseId: r.warehouse_id.toString(),
    date: r.adjustment_date,
    reasonCodeId: r.reason_code_id.toString(),
    note: r.note,
    reviewStatus: r.review_status as AdjustmentItem['reviewStatus'],
    reviewNote: r.review_note,
    reviewedBy: r.reviewed_by?.toString() ?? null,
    reviewedAt: r.reviewed_at?.toISOString() ?? null,
    postedAt: r.posted_at?.toISOString() ?? null,
    postedBy: r.posted_by?.toString() ?? null,
    postedByName: personName(r.posted_by_ar, r.posted_by_en),
    reviewedByName: personName(r.reviewed_by_ar, r.reviewed_by_en),
    approvedByName: personName(r.approved_by_ar, r.approved_by_en),
    lineCount: r.line_count,
    journalEntryId: r.journal_id?.toString() ?? null,
    rowVersion: r.row_version,
    ...(showValues ? { totalValueFils: r.total_value_fils?.toString() ?? null } : {}),
  };
}

export async function getAdjustment(db: Db, auth: Auth, id: bigint): Promise<AdjustmentDetail> {
  const row = await adjustmentBase(db).where('a.id', '=', id).executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'No such adjustment');
  const showValues = canSeeValues(auth);
  const lines = await db
    .selectFrom('inv.adjustment_lines as l')
    .innerJoin('md.items as i', 'i.id', 'l.item_id')
    .select([
      'l.line_no',
      'l.item_id',
      'i.code',
      'i.name_ar',
      'i.name_en',
      'i.unit_id',
      'l.stock_status',
      'l.target_status',
      'l.quantity',
      'l.note',
      'l.entered_unit_cost_4dp',
      'l.value_fils',
    ])
    .where('l.adjustment_id', '=', id)
    .orderBy('l.line_no')
    .execute();
  return {
    ...adjustmentItem(row, showValues),
    journalEntryNumber: row.entry_number,
    lines: lines.map((l) => ({
      lineNo: l.line_no,
      itemId: l.item_id.toString(),
      itemCode: l.code,
      nameAr: l.name_ar,
      nameEn: l.name_en,
      unitId: l.unit_id.toString(),
      stockStatus: l.stock_status as StockStatus,
      targetStatus: (l.target_status as StockStatus | null) ?? null,
      quantityMilli: quantityFromDb(l.quantity).toString(),
      note: l.note,
      ...(showValues
        ? {
            unitCost4dp: l.entered_unit_cost_4dp?.toString() ?? null,
            valueFils: l.value_fils?.toString() ?? null,
          }
        : {}),
    })),
  };
}

export async function listAdjustments(
  db: Db,
  auth: Auth,
  query: AdjustmentsQuery,
): Promise<AdjustmentsResponse> {
  let q = adjustmentBase(db).where('a.status', '=', 'posted');
  if (query.kind) q = q.where('a.kind', '=', query.kind);
  if (query.review) q = q.where('a.review_status', '=', query.review);
  if (query.itemId) {
    const itemId = BigInt(query.itemId);
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom('inv.adjustment_lines as l')
          .select('l.id')
          .whereRef('l.adjustment_id', '=', 'a.id')
          .where('l.item_id', '=', itemId),
      ),
    );
  }
  const total = await q
    .clearSelect()
    .select(sql<number>`count(*)::int`.as('n'))
    .executeTakeFirstOrThrow();
  const rows = await q
    .orderBy('a.id', 'desc')
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .execute();
  const showValues = canSeeValues(auth);
  return { total: total.n, adjustments: rows.map((r) => adjustmentItem(r, showValues)) };
}

/** Decision 0003: the storekeeper marks an oversell reviewed, with a note. */
export async function reviewOversell(
  trx: Transaction<DB>,
  auth: Auth,
  id: bigint,
  body: ReviewOversellRequest,
): Promise<AdjustmentDetail> {
  const result = await trx
    .updateTable('inv.adjustments')
    .set({ review_status: 'reviewed', review_note: body.note })
    .where('id', '=', id)
    .where('kind', '=', 'oversell')
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'inv.adjustments', id, result);
  return getAdjustment(trx, auth, id);
}

// ---------------------------------------------------------------------------------------------
// The item stock card and the stock tiles
// ---------------------------------------------------------------------------------------------

export async function itemStock(
  db: Db,
  auth: Auth,
  itemId: bigint,
  page: number,
  pageSize: number,
): Promise<ItemStockResponse> {
  const showValues = canSeeValues(auth);
  const balances = await db
    .selectFrom('inv.balances')
    .selectAll()
    .where('item_id', '=', itemId)
    .orderBy('warehouse_id')
    .orderBy('stock_status')
    .execute();
  const total = await db
    .selectFrom('inv.movements')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('item_id', '=', itemId)
    .executeTakeFirstOrThrow();
  const movements = await db
    .selectFrom('inv.movements as m')
    .leftJoin('inv.adjustment_lines as al', 'al.id', 'm.adjustment_line_id')
    .leftJoin('inv.adjustments as a', 'a.id', 'al.adjustment_id')
    .leftJoin('inv.count_lines as cl', 'cl.id', 'm.count_line_id')
    .leftJoin('inv.counts as c', 'c.id', 'cl.count_id')
    .select([
      'm.id',
      'm.movement_type',
      'm.occurred_at',
      'm.movement_date',
      'm.warehouse_id',
      'm.stock_status',
      'm.quantity',
      'm.qty_after',
      'm.value_4dp',
      'm.value_fils',
      'a.id as adjustment_id',
      'a.doc_number as adjustment_number',
      'a.reason_code_id as adjustment_reason',
      'c.id as count_id',
      'c.doc_number as count_number',
      'cl.reason_code_id as count_reason',
    ])
    .where('m.item_id', '=', itemId)
    .orderBy('m.id', 'desc')
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .execute();
  return {
    totalMovements: total.n,
    balances: balances.map((b) => ({
      warehouseId: b.warehouse_id.toString(),
      stockStatus: b.stock_status as StockStatus,
      quantityMilli: quantityFromDb(b.quantity).toString(),
      ...(showValues
        ? {
            value4dp: b.value_4dp.toString(),
            bookValueFils: b.book_value_fils.toString(),
            avgUnitCost4dp: b.avg_unit_cost_4dp?.toString() ?? null,
          }
        : {}),
    })),
    movements: movements.map((m) => ({
      id: m.id.toString(),
      movementType: m.movement_type as MovementType,
      occurredAt: m.occurred_at.toISOString(),
      movementDate: m.movement_date,
      warehouseId: m.warehouse_id.toString(),
      stockStatus: m.stock_status as StockStatus,
      quantityMilli: quantityFromDb(m.quantity).toString(),
      qtyAfterMilli: quantityFromDb(m.qty_after).toString(),
      documentKind: m.adjustment_id ? 'adjustment' : m.count_id ? 'count' : null,
      documentId: (m.adjustment_id ?? m.count_id)?.toString() ?? null,
      documentNumber: m.adjustment_number ?? m.count_number ?? null,
      reasonCodeId: (m.adjustment_reason ?? m.count_reason)?.toString() ?? null,
      ...(showValues
        ? { value4dp: m.value_4dp.toString(), valueFils: m.value_fils.toString() }
        : {}),
    })),
  };
}

export async function stockSummary(db: Db, auth: Auth): Promise<StockSummary> {
  const row = await db
    .selectFrom('md.items as i')
    .leftJoin(
      db
        .selectFrom('inv.balances')
        .select([
          'item_id',
          sql<string>`sum(quantity) FILTER (WHERE stock_status = 'available')`.as('on_hand'),
          sql<string>`sum(quantity) FILTER (WHERE stock_status = 'defective')`.as('defective'),
        ])
        .groupBy('item_id')
        .as('s'),
      's.item_id',
      'i.id',
    )
    .select([
      sql<number>`count(*) FILTER (WHERE i.reorder_level IS NOT NULL AND coalesce(s.on_hand, 0) <= i.reorder_level)::int`.as(
        'to_reorder',
      ),
      sql<number>`count(*) FILTER (WHERE coalesce(s.defective, 0) > 0)::int`.as('defective_items'),
    ])
    .where('i.item_type', '=', 'stock')
    .where('i.is_active', '=', true)
    .executeTakeFirstOrThrow();
  const pending = await db
    .selectFrom('inv.adjustments')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('review_status', '=', 'pending')
    .executeTakeFirstOrThrow();
  let valueFils: string | undefined;
  if (canSeeValues(auth)) {
    const v = await db
      .selectFrom('inv.balances')
      .select(sql<string>`coalesce(sum(book_value_fils), 0)::text`.as('v'))
      .executeTakeFirstOrThrow();
    valueFils = v.v;
  }
  return {
    toReorder: row.to_reorder,
    defectiveItems: row.defective_items,
    pendingReviews: pending.n,
    ...(valueFils !== undefined ? { valueFils } : {}),
  };
}
