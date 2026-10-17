/**
 * Drawer shifts (decisions 0004, 0006, 0056–0058): open with the float, paid-in / paid-out,
 * cash drops and top-ups, No Sale, the X report, the blind count (the expected amount is shown
 * only after counting), one recount with a supervisor's approval, the close (Z-) and the owner's
 * or accountant's acceptance of the over/short. The database checks every rule again.
 */
import type { FastifyRequest } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  AcceptVarianceRequest,
  CashAlert,
  CashMovementItem,
  CashMovementRequest,
  CloseShiftRequest,
  CashCountDetail,
  CountLines,
  CountResult,
  NoSaleRequest,
  OpenShiftRequest,
  RecountRequest,
  ShiftListItem,
  ShiftReport,
  ShiftsQuery,
  ShiftsResponse,
  ShiftSummary,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { filledByDatabase } from '../../platform/db/stamped';
import { fieldError } from '../../platform/db/versioned';
import { AppError, ruleError } from '../../platform/errors/app-error';
import { requireAlso } from '../../platform/permissions';
import { consumeApproval } from '../approvals/service';
import { variancePosting } from '../ledger/cash-posting';
import { postEntry } from '../ledger/posting';
import {
  addCashMovement,
  checkDropDue,
  drawerAccount,
  drawerEvent,
  ensureRegister,
  expectedCash,
  myOpenShift,
  openShiftOnDevice,
  requirePosDevice,
  settingBigint,
  today,
} from './drawer';

type Db = Kysely<DB> | Transaction<DB>;
type Auth = { userId: bigint; permissions: ReadonlySet<string> } | null;

const names = (r: { display_name_ar: string; display_name_en: string }) => ({
  displayNameAr: r.display_name_ar,
  displayNameEn: r.display_name_en,
});

function shiftBase(db: Db) {
  return db
    .selectFrom('cash.shifts as s')
    .innerJoin('cash.registers as r', 'r.id', 's.register_id')
    .innerJoin('auth.users as u', 'u.id', 's.cashier_id')
    .select([
      's.id',
      's.shift_number',
      's.status',
      's.register_id',
      'r.code as register_code',
      's.cashier_id',
      'u.display_name_ar',
      'u.display_name_en',
      's.opened_at',
      's.closed_at',
      's.opening_float_fils',
      's.expected_cash_fils',
      's.counted_cash_fils',
      's.variance_fils',
      's.variance_note',
    ]);
}
type ShiftRow = Awaited<ReturnType<ReturnType<typeof shiftBase>['executeTakeFirstOrThrow']>>;

const summaryOf = (s: ShiftRow): ShiftSummary => ({
  id: s.id.toString(),
  shiftNumber: s.shift_number,
  status: s.status as 'open' | 'closed',
  registerId: s.register_id.toString(),
  registerCode: s.register_code,
  cashierId: s.cashier_id.toString(),
  cashierName: names(s),
  openedAt: s.opened_at.toISOString(),
  closedAt: s.closed_at?.toISOString() ?? null,
  openingFloatFils: s.opening_float_fils.toString(),
});

export async function shiftSummary(db: Db, id: bigint): Promise<ShiftSummary> {
  return summaryOf(await shiftBase(db).where('s.id', '=', id).executeTakeFirstOrThrow());
}

// ---------------------------------------------------------------------------------------------
// Opening and moving cash
// ---------------------------------------------------------------------------------------------

/** Opens the user's shift on this PC's drawer; the float comes from the safe (row 18). */
export async function openShift(
  trx: Transaction<DB>,
  request: FastifyRequest,
  body: OpenShiftRequest,
): Promise<ShiftSummary> {
  const device = requirePosDevice(request.device);
  const registerId = await ensureRegister(trx, device);
  if (await openShiftOnDevice(trx, device.id)) {
    throw ruleError('SHIFT_ALREADY_OPEN', 'This drawer already has an open shift');
  }
  // One open shift per cashier (decision 0004): name the PC it is open on, so it can be closed there.
  const elsewhere = await trx
    .selectFrom('cash.shifts as s')
    .innerJoin('cash.registers as r', 'r.id', 's.register_id')
    .innerJoin('auth.devices as d', 'd.id', 'r.device_id')
    .select(['d.code'])
    .where('s.cashier_id', '=', request.auth!.userId)
    .where('s.status', '=', 'open')
    .executeTakeFirst();
  if (elsewhere) {
    throw ruleError('SHIFT_OPEN_ELSEWHERE', 'The cashier has an open shift on another PC', {
      deviceCode: elsewhere.code,
    });
  }
  const float = BigInt(body.openingFloatFils);
  const shift = await trx
    .insertInto('cash.shifts')
    .values(filledByDatabase('cash.shifts', { register_id: registerId, opening_float_fils: float }))
    .returning('id')
    .executeTakeFirstOrThrow();
  if (float > 0n) {
    const m = await addCashMovement(trx, {
      shiftId: shift.id,
      type: 'opening_float',
      amountFils: float,
    });
    await drawerEvent(trx, {
      registerId,
      shiftId: shift.id,
      type: 'open_cash_movement',
      cashMovementId: m.id,
    });
  }
  return shiftSummary(trx, shift.id);
}

const MOVEMENT_PERMISSION: Record<CashMovementRequest['movementType'], string> = {
  paid_in: 'cash.paid_in',
  paid_out: 'cash.paid_out',
  cash_drop: 'cash.drop',
  float_top_up: 'cash.drop',
};

/** Paid-in / paid-out (with a reason), a cash drop or a float top-up, on the user's own shift. */
export async function moveCash(
  trx: Transaction<DB>,
  request: FastifyRequest,
  body: CashMovementRequest,
): Promise<{ movement: CashMovementItem; dropDue: boolean }> {
  const auth = request.auth!;
  const shift = await myOpenShift(trx, request.device, auth.userId);
  const permission = MOVEMENT_PERMISSION[body.movementType];
  let approvalId: bigint | null = null;
  if (!auth.permissions.has(permission)) {
    // A paid-out may be approved by a supervisor instead (the permission is approvable).
    if (body.movementType !== 'paid_out' || !body.approvalId) requireAlso(auth, permission);
    approvalId = BigInt(body.approvalId!);
    const context = await consumeApproval(
      trx,
      approvalId,
      permission,
      `cash.movements:${shift.id}`,
    );
    if (context.amountFils !== undefined && context.amountFils !== body.amountFils) {
      throw new AppError('APPROVAL_INVALID', 'The approval was given for another amount');
    }
  }
  const paid = body.movementType === 'paid_in' || body.movementType === 'paid_out';
  if (paid && !body.reasonCodeId) throw fieldError('reasonCodeId', 'required');
  if (paid) {
    const reason = await trx
      .selectFrom('sys.reason_codes')
      .select(['requires_note'])
      .where('id', '=', BigInt(body.reasonCodeId!))
      .executeTakeFirst();
    if (reason?.requires_note && !body.note) throw fieldError('note', 'required');
  }
  const m = await addCashMovement(trx, {
    shiftId: shift.id,
    type: body.movementType,
    amountFils: BigInt(body.amountFils),
    reasonCodeId: paid ? BigInt(body.reasonCodeId!) : null,
    note: body.note ?? null,
    counterparty: body.counterparty ?? null,
    approvalId,
  });
  await drawerEvent(trx, {
    registerId: shift.registerId,
    shiftId: shift.id,
    type: 'open_cash_movement',
    cashMovementId: m.id,
  });
  const [movement] = await movementsOf(trx, shift.id, m.id);
  return { movement: movement!, dropDue: await checkDropDue(trx, shift.id) };
}

/** Opens the drawer without a sale: its permission and a reason, always written (0004). */
export async function noSale(
  trx: Transaction<DB>,
  request: FastifyRequest,
  body: NoSaleRequest,
): Promise<void> {
  const shift = await myOpenShift(trx, request.device, request.auth!.userId);
  await drawerEvent(trx, {
    registerId: shift.registerId,
    shiftId: shift.id,
    type: 'open_no_sale',
    reasonCodeId: BigInt(body.reasonCodeId),
    note: body.note ?? null,
  });
}

async function movementsOf(db: Db, shiftId: bigint, onlyId?: bigint): Promise<CashMovementItem[]> {
  let q = db
    .selectFrom('cash.movements as m')
    .leftJoin('sys.reason_codes as rc', 'rc.id', 'm.reason_code_id')
    .select([
      'm.id',
      'm.voucher_number',
      'm.movement_type',
      'm.direction',
      'm.amount_fils',
      'm.note',
      'm.created_at',
      'rc.name_ar',
      'rc.name_en',
    ])
    .where('m.shift_id', '=', shiftId);
  if (onlyId !== undefined) q = q.where('m.id', '=', onlyId);
  const rows = await q.orderBy('m.id').execute();
  return rows.map((r) => ({
    id: r.id.toString(),
    voucherNumber: r.voucher_number,
    movementType: r.movement_type as CashMovementItem['movementType'],
    direction: r.direction as 'in' | 'out',
    amountFils: r.amount_fils.toString(),
    reasonNameAr: r.name_ar,
    reasonNameEn: r.name_en,
    note: r.note,
    createdAt: r.created_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------------------------
// Counting and closing
// ---------------------------------------------------------------------------------------------

async function insertCount(
  trx: Transaction<DB>,
  shiftId: bigint,
  body: CountLines,
  recount: { supersedesId: bigint; approvalId: bigint } | null,
): Promise<{ id: bigint; total: bigint }> {
  const ids = body.lines.map((l) => l.denominationId);
  if (new Set(ids).size !== ids.length) throw fieldError('lines', 'duplicate');
  const values = new Map(
    (
      await trx
        .selectFrom('md.cash_denominations')
        .select(['id', 'value_fils'])
        .where('is_active', '=', true)
        .execute()
    ).map((d) => [d.id.toString(), d.value_fils]),
  );
  let total = BigInt(body.otherAmountFils ?? '0');
  for (const [i, l] of body.lines.entries()) {
    const value = values.get(l.denominationId);
    if (value === undefined) throw fieldError(`lines.${i}.denominationId`, 'unknown');
    total += value * BigInt(l.quantity);
  }
  const count = await trx
    .insertInto('cash.counts')
    .values(
      filledByDatabase('cash.counts', {
        shift_id: shiftId,
        purpose: 'closing',
        total_fils: total,
        other_amount_fils: BigInt(body.otherAmountFils ?? '0'),
        supersedes_id: recount?.supersedesId ?? null,
        approval_id: recount?.approvalId ?? null,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  const lines = body.lines.filter((l) => l.quantity > 0);
  if (lines.length > 0) {
    await trx
      .insertInto('cash.count_lines')
      .values(
        lines.map((l) =>
          filledByDatabase('cash.count_lines', {
            count_id: count.id,
            denomination_id: BigInt(l.denominationId),
            quantity: l.quantity,
          }),
        ),
      )
      .execute();
  }
  return { id: count.id, total };
}

async function closingCounts(db: Db, shiftId: bigint) {
  return db
    .selectFrom('cash.counts')
    .select(['id', 'supersedes_id', 'total_fils'])
    .where('shift_id', '=', shiftId)
    .where('purpose', '=', 'closing')
    .orderBy('id')
    .execute();
}

/** The blind count (0006): the cashier counts first; only then the expected amount is shown. */
export async function countCash(
  trx: Transaction<DB>,
  request: FastifyRequest,
  body: CountLines | RecountRequest,
  isRecount: boolean,
): Promise<CountResult> {
  const shift = await myOpenShift(trx, request.device, request.auth!.userId);
  const existing = await closingCounts(trx, shift.id);
  const first = existing.find((c) => c.supersedes_id === null);
  let recount: { supersedesId: bigint; approvalId: bigint } | null = null;
  if (!isRecount) {
    if (first) throw ruleError('COUNT_ALREADY_DONE', 'The closing count is already done');
  } else {
    if (!first) throw ruleError('COUNT_MISSING', 'Count the cash first');
    if (existing.some((c) => c.supersedes_id !== null)) {
      throw ruleError('RECOUNT_USED', 'The one recount is already used');
    }
    const approvalId = BigInt((body as RecountRequest).approvalId);
    await consumeApproval(trx, approvalId, 'shifts.recount', `cash.shifts:${shift.id}:recount`);
    recount = { supersedesId: first.id, approvalId };
  }
  const count = await insertCount(trx, shift.id, body, recount);
  await drawerEvent(trx, { registerId: shift.registerId, shiftId: shift.id, type: 'open_count' });
  const expected = await expectedCash(trx, shift.id);
  return {
    countId: count.id.toString(),
    isRecount,
    countedFils: count.total.toString(),
    expectedFils: expected.toString(),
    varianceFils: (count.total - expected).toString(),
    canRecount: !isRecount,
  };
}

/**
 * Closes the user's shift: the final count (the recount when there is one) goes to the safe, the
 * database works out expected, counted and variance, and the Z report is frozen with the shift.
 */
export async function closeShift(
  trx: Transaction<DB>,
  request: FastifyRequest,
  body: CloseShiftRequest,
): Promise<ShiftReport> {
  const auth = request.auth!;
  const shift = await myOpenShift(trx, request.device, auth.userId);
  const counts = await closingCounts(trx, shift.id);
  const final = counts.find((c) => c.supersedes_id !== null) ?? counts[0];
  if (!final) throw ruleError('COUNT_MISSING', 'Count the cash before closing the shift');
  if (final.total_fils > 0n) {
    await addCashMovement(trx, {
      shiftId: shift.id,
      type: 'closing_transfer',
      amountFils: final.total_fils,
    });
  }
  const figures = await shiftReport(trx, shift.id, { reveal: true });
  await trx
    .updateTable('cash.shifts')
    .set({
      status: 'closed',
      variance_note: body.varianceNote ?? null,
      z_snapshot: JSON.stringify(figures),
      // Placeholders: the database sets the real figures (cash.shift_close_rules).
      closing_count_id: final.id,
      expected_cash_fils: 0n,
      counted_cash_fils: 0n,
      variance_fils: 0n,
    })
    .where('id', '=', shift.id)
    .execute();
  await checkRepeatedVariance(trx, auth.userId);
  return shiftReport(trx, shift.id, { reveal: true });
}

/** Decision 0058: the same cashier above the variance amount N times within the window. */
async function checkRepeatedVariance(trx: Transaction<DB>, cashierId: bigint) {
  const amount = await settingBigint(trx, 'cash.variance_alert_fils');
  const times = await settingBigint(trx, 'cash.variance_alert_repeat_count');
  const days = await settingBigint(trx, 'cash.variance_alert_days');
  if (amount === null || times === null || days === null) return;
  const { rows } = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM cash.shifts
     WHERE cashier_id = ${cashierId} AND status = 'closed' AND abs(variance_fils) > ${amount}
       AND closed_at > now() - make_interval(days => ${Number(days)})`.execute(trx);
  const n = BigInt(rows[0]!.n);
  if (n < times) return;
  await sql`INSERT INTO sys.alerts (alert_type, severity, entity_type, entity_id, params, dedupe_key)
            VALUES ('repeated_variance', 'warning', 'auth.users', ${cashierId.toString()},
                    ${JSON.stringify({ cashierId: cashierId.toString(), times: n.toString(), days: days.toString() })}::jsonb,
                    ${`repeated_variance:${cashierId}`})
            ON CONFLICT (dedupe_key) WHERE acknowledged_at IS NULL DO NOTHING`.execute(trx);
}

// ---------------------------------------------------------------------------------------------
// Reports (X while open, Z when closed)
// ---------------------------------------------------------------------------------------------

async function countsOf(db: Db, shiftId: bigint): Promise<CashCountDetail[]> {
  const counts = await db
    .selectFrom('cash.counts')
    .select(['id', 'supersedes_id', 'total_fils', 'other_amount_fils', 'counted_at'])
    .where('shift_id', '=', shiftId)
    .where('purpose', '=', 'closing')
    .orderBy('id')
    .execute();
  const lines =
    counts.length === 0
      ? []
      : await db
          .selectFrom('cash.count_lines as l')
          .innerJoin('md.cash_denominations as d', 'd.id', 'l.denomination_id')
          .select(['l.count_id', 'd.value_fils', 'l.quantity', 'l.amount_fils'])
          .where(
            'l.count_id',
            'in',
            counts.map((c) => c.id),
          )
          .orderBy('d.value_fils', 'desc')
          .execute();
  return counts.map((c) => ({
    id: c.id.toString(),
    isRecount: c.supersedes_id !== null,
    totalFils: c.total_fils.toString(),
    otherAmountFils: c.other_amount_fils.toString(),
    countedAt: c.counted_at.toISOString(),
    lines: lines
      .filter((l) => l.count_id === c.id)
      .map((l) => ({
        valueFils: l.value_fils.toString(),
        quantity: l.quantity,
        amountFils: l.amount_fils.toString(),
      })),
  }));
}

/**
 * The shift's figures. `reveal`: show the expected cash (after the count, once closed, or to
 * someone who may see all shifts); otherwise it stays hidden for the blind count (0006).
 */
export async function shiftReport(
  db: Db,
  shiftId: bigint,
  opts: { reveal: boolean },
): Promise<ShiftReport> {
  const s = await shiftBase(db).where('s.id', '=', shiftId).executeTakeFirst();
  if (!s) throw new AppError('NOT_FOUND', 'No such shift');
  const docs = await db
    .selectFrom('sales.documents')
    .select([
      'doc_type',
      sql<string>`count(*)`.as('n'),
      sql<string>`coalesce(sum(total_fils), 0)`.as('total'),
      sql<string>`coalesce(sum(vat_fils), 0)`.as('vat'),
      sql<string>`coalesce(sum(discount_total_fils), 0)`.as('discount'),
    ])
    .where('shift_id', '=', shiftId)
    .where('status', '=', 'issued')
    .groupBy('doc_type')
    .execute();
  const invoices = docs.find((d) => d.doc_type === 'invoice');
  const returns = docs.find((d) => d.doc_type === 'credit_note');
  // A4 invoices the cashier issued during the shift: part of the shift's sales figures, never of
  // its expected cash (0063).
  const a4 = await db
    .selectFrom('sales.documents')
    .select([
      sql<string>`count(*)`.as('n'),
      sql<string>`coalesce(sum(total_fils), 0)`.as('total'),
      sql<string>`coalesce(sum(vat_fils), 0)`.as('vat'),
      sql<string>`coalesce(sum(discount_total_fils), 0)`.as('discount'),
    ])
    .where('channel', '=', 'office')
    .where('doc_type', '=', 'invoice')
    .where('status', '=', 'issued')
    .where('issued_by', '=', s.cashier_id)
    .where('issued_at', '>=', s.opened_at)
    .where('issued_at', '<=', s.closed_at ?? sql<Date>`now()`)
    .executeTakeFirstOrThrow();
  const methods = await db
    .selectFrom('sales.payments as p')
    .innerJoin('md.payment_methods as m', 'm.id', 'p.payment_method_id')
    .select([
      'm.id',
      'm.name_ar',
      'm.name_en',
      'm.kind',
      sql<string>`coalesce(sum(p.amount_fils) FILTER (WHERE p.direction = 'in'), 0)`.as('in_fils'),
      sql<string>`coalesce(sum(p.amount_fils) FILTER (WHERE p.direction = 'out'), 0)`.as(
        'out_fils',
      ),
    ])
    .where('p.shift_id', '=', shiftId)
    .groupBy(['m.id', 'm.name_ar', 'm.name_en', 'm.kind', 'm.sort_order'])
    .orderBy('m.sort_order')
    .execute();
  const noSales = await db
    .selectFrom('cash.drawer_events')
    .select(sql<string>`count(*)`.as('n'))
    .where('shift_id', '=', shiftId)
    .where('event_type', '=', 'open_no_sale')
    .executeTakeFirstOrThrow();
  const counts = await countsOf(db, shiftId);
  const acceptance = await db
    .selectFrom('cash.variance_acceptances as a')
    .innerJoin('auth.users as u', 'u.id', 'a.accepted_by')
    .select(['a.accepted_at', 'a.note', 'u.display_name_ar', 'u.display_name_en'])
    .where('a.shift_id', '=', shiftId)
    .executeTakeFirst();
  const closed = s.status === 'closed';
  const reveal = opts.reveal || closed || counts.length > 0;
  const expected = closed ? s.expected_cash_fils : reveal ? await expectedCash(db, shiftId) : null;
  return {
    shift: summaryOf(s),
    salesCount: Number(invoices?.n ?? 0),
    returnsCount: Number(returns?.n ?? 0),
    grossSalesFils: invoices?.total ?? '0',
    vatFils: (BigInt(invoices?.vat ?? 0) + BigInt(a4.vat)).toString(),
    discountFils: (BigInt(invoices?.discount ?? 0) + BigInt(a4.discount)).toString(),
    returnsFils: returns?.total ?? '0',
    a4InvoicesCount: Number(a4.n),
    a4InvoicesFils: a4.total,
    totalSalesFils: (BigInt(invoices?.total ?? 0) + BigInt(a4.total)).toString(),
    byMethod: methods.map((m) => ({
      methodId: m.id.toString(),
      nameAr: m.name_ar,
      nameEn: m.name_en,
      kind: m.kind as ShiftReport['byMethod'][number]['kind'],
      receivedFils: m.in_fils,
      refundedFils: m.out_fils,
    })),
    movements: await movementsOf(db, shiftId),
    noSaleCount: Number(noSales.n),
    expectedCashFils: expected?.toString() ?? null,
    counts,
    countedCashFils: s.counted_cash_fils?.toString() ?? null,
    varianceFils: s.variance_fils?.toString() ?? null,
    varianceNote: s.variance_note,
    acceptance: acceptance
      ? {
          acceptedAt: acceptance.accepted_at.toISOString(),
          acceptedBy: names(acceptance),
          note: acceptance.note,
        }
      : null,
  };
}

/** The X report of the user's own open shift. */
export async function xReport(db: Db, request: FastifyRequest): Promise<ShiftReport> {
  const auth = request.auth!;
  const shift = await myOpenShift(db, request.device, auth.userId);
  return shiftReport(db, shift.id, { reveal: auth.permissions.has('shifts.view_all') });
}

/** A shift's report: one's own, or any shift with shifts.view_all. */
export async function getShiftReport(db: Db, auth: Auth, id: bigint): Promise<ShiftReport> {
  const s = await db
    .selectFrom('cash.shifts')
    .select('cashier_id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!s) throw new AppError('NOT_FOUND', 'No such shift');
  if (s.cashier_id !== auth?.userId) requireAlso(auth, 'shifts.view_all');
  return shiftReport(db, id, { reveal: auth?.permissions.has('shifts.view_all') ?? false });
}

export async function listShifts(db: Db, auth: Auth, query: ShiftsQuery): Promise<ShiftsResponse> {
  const all = auth?.permissions.has('shifts.view_all') ?? false;
  let q = db
    .selectFrom('cash.shifts as s')
    .leftJoin('cash.variance_acceptances as a', 'a.shift_id', 's.id');
  if (!all) q = q.where('s.cashier_id', '=', auth!.userId);
  else if (query.cashierId) q = q.where('s.cashier_id', '=', BigInt(query.cashierId));
  if (query.status) q = q.where('s.status', '=', query.status);
  if (query.pendingAcceptance) {
    q = q
      .where('s.status', '=', 'closed')
      .where('a.id', 'is', null)
      .where('s.variance_fils', '<>', 0n);
  }
  const total = await q.select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow();
  const ids = await q
    .select(['s.id', sql<boolean>`a.id IS NOT NULL`.as('accepted')])
    .orderBy('s.id', 'desc')
    .limit(query.limit)
    .offset(query.offset)
    .execute();
  const rows =
    ids.length === 0
      ? []
      : await shiftBase(db)
          .where(
            's.id',
            'in',
            ids.map((i) => i.id),
          )
          .orderBy('s.id', 'desc')
          .execute();
  const accepted = new Map(ids.map((i) => [i.id.toString(), i.accepted]));
  const shifts: ShiftListItem[] = rows.map((r) => ({
    ...summaryOf(r),
    // Hidden while open: the blind count (0006).
    expectedCashFils: r.status === 'closed' ? (r.expected_cash_fils?.toString() ?? null) : null,
    countedCashFils: r.counted_cash_fils?.toString() ?? null,
    varianceFils: r.variance_fils?.toString() ?? null,
    accepted: accepted.get(r.id.toString()) ?? false,
  }));
  return { total: Number(total.n), shifts };
}

/** Decision 0058: the owner or the accountant accepts a closed shift's over/short (row 19). */
export async function acceptVariance(
  trx: Transaction<DB>,
  auth: Auth,
  shiftId: bigint,
  body: AcceptVarianceRequest,
): Promise<ShiftReport> {
  const s = await trx
    .selectFrom('cash.shifts')
    .select(['status', 'variance_fils', 'shift_number'])
    .where('id', '=', shiftId)
    .executeTakeFirst();
  if (!s) throw new AppError('NOT_FOUND', 'No such shift');
  await trx
    .insertInto('cash.variance_acceptances')
    .values(
      filledByDatabase('cash.variance_acceptances', {
        shift_id: shiftId,
        reason_code_id: body.reasonCodeId ? BigInt(body.reasonCodeId) : null,
        note: body.note,
      }),
    )
    .execute();
  const variance = s.variance_fils ?? 0n;
  if (variance !== 0n) {
    await postEntry(trx, {
      date: await today(trx),
      source: { type: 'shift_close', id: shiftId },
      memo: s.shift_number,
      amounts: variancePosting(variance, await drawerAccount(trx)),
    });
  }
  return shiftReport(trx, shiftId, { reveal: auth?.permissions.has('shifts.view_all') ?? true });
}

/** Open cash alerts (drops due, repeated variances), for whoever sees all shifts. */
export async function cashAlerts(db: Db): Promise<CashAlert[]> {
  const rows = await db
    .selectFrom('sys.alerts')
    .select(['id', 'alert_type', 'created_at', 'params'])
    .where('alert_type', 'in', ['cash_drop_due', 'repeated_variance'])
    .where('acknowledged_at', 'is', null)
    .orderBy('id', 'desc')
    .limit(100)
    .execute();
  return rows.map((r) => ({
    id: r.id.toString(),
    alertType: r.alert_type as CashAlert['alertType'],
    createdAt: r.created_at.toISOString(),
    params: r.params as Record<string, unknown>,
  }));
}
