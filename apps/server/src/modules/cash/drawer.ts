/**
 * The drawer of this PC and its open shift (decision 0004): a POS PC has one register, made the
 * first time someone opens a shift there; only the shift's own cashier sells and moves cash on it.
 * Every cash movement posts its journal entry in the same transaction (posting map rows 16–18),
 * and every opening of the drawer is written to the drawer events.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../platform/db/schema.generated';
import { filledByDatabase } from '../../platform/db/stamped';
import { AppError, ruleError } from '../../platform/errors/app-error';
import type { DeviceInfo } from '../../platform/http/access';
import { movementPosting, type DrawerMovementType } from '../ledger/cash-posting';
import { postEntry } from '../ledger/posting';
import { today, warehouseOf } from '../inventory/service';

type Db = Kysely<DB> | Transaction<DB>;

/** POS sales and shifts only on a PC enrolled as POS (decision 0021). */
export function requirePosDevice(device: DeviceInfo | null | undefined): DeviceInfo {
  if (!device || device.kind !== 'pos') {
    throw ruleError('POS_DEVICE_ONLY', 'This works only on a PC enrolled as a point of sale');
  }
  return device;
}

export async function registerOf(db: Db, deviceId: bigint) {
  return db
    .selectFrom('cash.registers')
    .select(['id', 'code', 'warehouse_id', 'is_active'])
    .where('device_id', '=', deviceId)
    .executeTakeFirst();
}

/** This PC's register; made the first time with the defaults (the POS series, the default store). */
export async function ensureRegister(trx: Transaction<DB>, device: DeviceInfo): Promise<bigint> {
  const existing = await registerOf(trx, device.id);
  if (existing) {
    if (!existing.is_active) throw ruleError('REGISTER_INACTIVE', 'This register is not active');
    return existing.id;
  }
  const base = `REG-${device.code}`
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, '-')
    .slice(0, 32);
  // A PC enrolled again under the same name: the old enrollment keeps its drawer (and its
  // history), so the new drawer takes the next free code (REG-POS-01-2, -3, …).
  const taken = new Set(
    (
      await trx
        .selectFrom('cash.registers')
        .select('code')
        .where('code', 'like', `${base.slice(0, 28)}%`)
        .execute()
    ).map((r) => r.code),
  );
  let code = base;
  for (let n = 2; taken.has(code); n += 1) code = `${base.slice(0, 31 - String(n).length)}-${n}`;
  const series = await trx
    .selectFrom('sys.document_series')
    .select(['id', 'doc_type', 'channel'])
    .where((eb) =>
      eb.or([
        eb.and([eb('doc_type', '=', 'invoice'), eb('channel', '=', 'pos')]),
        eb('doc_type', '=', 'receipt'),
      ]),
    )
    .where('is_default', '=', true)
    .execute();
  const pos = series.find((s) => s.doc_type === 'invoice');
  const rct = series.find((s) => s.doc_type === 'receipt');
  if (!pos || !rct) throw new AppError('INTERNAL', 'The POS series are missing');
  const threshold = await settingBigint(trx, 'cash.drop_alert_fils');
  const row = await trx
    .insertInto('cash.registers')
    .values(
      filledByDatabase('cash.registers', {
        code,
        name_ar: `درج ${device.code}`.slice(0, 100),
        name_en: `Drawer ${device.code}`.slice(0, 100),
        branch_id: device.branchId,
        device_id: device.id,
        warehouse_id: await warehouseOf(trx, undefined),
        invoice_series_id: pos.id,
        receipt_series_id: rct.id,
        drop_threshold_fils: threshold && threshold > 0n ? threshold : 300_000n,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function settingBigint(db: Db, key: string): Promise<bigint | null> {
  const { rows } = await sql<{
    v: string | null;
  }>`SELECT sys.setting_bigint(${key})::text AS v`.execute(db);
  return rows[0]?.v == null ? null : BigInt(rows[0].v);
}

/** The open shift on this PC's drawer, whoever holds it. */
export async function openShiftOnDevice(db: Db, deviceId: bigint) {
  return db
    .selectFrom('cash.shifts as s')
    .innerJoin('cash.registers as r', 'r.id', 's.register_id')
    .innerJoin('auth.users as u', 'u.id', 's.cashier_id')
    .select(['s.id', 's.cashier_id', 's.register_id', 'u.display_name_ar', 'u.display_name_en'])
    .where('r.device_id', '=', deviceId)
    .where('s.status', '=', 'open')
    .executeTakeFirst();
}

/** The signed-in user's open shift on this PC (decision 0004); refused otherwise. */
export async function myOpenShift(
  db: Db,
  device: DeviceInfo | null | undefined,
  userId: bigint,
): Promise<{ id: bigint; registerId: bigint }> {
  const d = requirePosDevice(device);
  const s = await openShiftOnDevice(db, d.id);
  if (!s) throw ruleError('SHIFT_NOT_OPEN', 'No shift is open on this drawer');
  if (s.cashier_id !== userId) {
    throw new AppError('PERMISSION_DENIED', 'Only the shift’s own cashier works on it', {
      rule: 'SHIFT_NOT_OWNER',
    });
  }
  return { id: s.id, registerId: s.register_id };
}

/** The account of the drawers: the POS cash payment method's account (data, decision 0018). */
export async function drawerAccount(db: Db): Promise<bigint> {
  const m = await db
    .selectFrom('md.payment_methods')
    .select('gl_account_id')
    .where('kind', '=', 'cash')
    .where('in_pos', '=', true)
    .where('is_active', '=', true)
    .orderBy('sort_order')
    .orderBy('id')
    .executeTakeFirst();
  if (!m) throw new AppError('INTERNAL', 'No active POS cash payment method');
  return m.gl_account_id;
}

/** One cash movement (CV-) and its journal entry; the database checks the shift and the rules. */
export async function addCashMovement(
  trx: Transaction<DB>,
  m: {
    shiftId: bigint;
    type: DrawerMovementType;
    amountFils: bigint;
    reasonCodeId?: bigint | null;
    note?: string | null;
    counterparty?: string | null;
    approvalId?: bigint | null;
    dropCountId?: bigint | null;
  },
) {
  const row = await trx
    .insertInto('cash.movements')
    .values(
      filledByDatabase('cash.movements', {
        shift_id: m.shiftId,
        movement_type: m.type,
        amount_fils: m.amountFils,
        reason_code_id: m.reasonCodeId ?? null,
        note: m.note ?? null,
        counterparty: m.counterparty ?? null,
        approval_id: m.approvalId ?? null,
        drop_count_id: m.dropCountId ?? null,
      }),
    )
    .returning(['id', 'voucher_number', 'movement_date'])
    .executeTakeFirstOrThrow();
  const reason = m.reasonCodeId
    ? await trx
        .selectFrom('sys.reason_codes')
        .select('gl_account_id')
        .where('id', '=', m.reasonCodeId)
        .executeTakeFirst()
    : undefined;
  await postEntry(trx, {
    date: row.movement_date,
    source: { type: 'cash_movement', id: row.id },
    memo: row.voucher_number,
    amounts: movementPosting({
      type: m.type,
      amountFils: m.amountFils,
      drawerAccountId: await drawerAccount(trx),
      reasonAccountId: reason?.gl_account_id ?? null,
    }),
  });
  return row;
}

export type DrawerEventType =
  'open_sale' | 'open_payment' | 'open_cash_movement' | 'open_count' | 'open_no_sale';

/** Writes that the drawer opens (and why). */
export async function drawerEvent(
  trx: Transaction<DB>,
  e: {
    registerId: bigint;
    shiftId: bigint;
    type: DrawerEventType;
    salesDocumentId?: bigint;
    paymentId?: bigint;
    cashMovementId?: bigint;
    reasonCodeId?: bigint;
    note?: string | null;
  },
) {
  await trx
    .insertInto('cash.drawer_events')
    .values(
      filledByDatabase('cash.drawer_events', {
        register_id: e.registerId,
        shift_id: e.shiftId,
        event_type: e.type,
        sales_document_id: e.salesDocumentId ?? null,
        payment_id: e.paymentId ?? null,
        cash_movement_id: e.cashMovementId ?? null,
        reason_code_id: e.reasonCodeId ?? null,
        note: e.note ?? null,
      }),
    )
    .execute();
}

export async function expectedCash(db: Db, shiftId: bigint): Promise<bigint> {
  const { rows } = await sql<{
    e: string;
  }>`SELECT cash.expected_cash(${shiftId})::text AS e`.execute(db);
  return BigInt(rows[0]!.e);
}

/**
 * Decision 0057: the drawer holds more than the cash-drop alert amount. Raises the alert once per
 * shift (an open alert of the same key is not repeated). Returns whether a drop is due.
 */
export async function checkDropDue(trx: Transaction<DB>, shiftId: bigint): Promise<boolean> {
  const limit = await settingBigint(trx, 'cash.drop_alert_fils');
  if (limit === null) return false;
  const cash = await expectedCash(trx, shiftId);
  if (cash <= limit) return false;
  await sql`INSERT INTO sys.alerts (alert_type, severity, entity_type, entity_id, params, dedupe_key)
            VALUES ('cash_drop_due', 'warning', 'cash.shifts', ${shiftId.toString()},
                    ${JSON.stringify({ shiftId: shiftId.toString() })}::jsonb,
                    ${`cash_drop_due:${shiftId}`})
            ON CONFLICT (dedupe_key) WHERE acknowledged_at IS NULL DO NOTHING`.execute(trx);
  return true;
}

export { today };
