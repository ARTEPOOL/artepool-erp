/**
 * Settings → Lists (decision 0034): technicians, payment methods, warehouses and reason codes.
 * The database checks their accounts and defaults; nothing is deleted (decision 0037).
 */
import type { Kysely, Transaction } from 'kysely';
import { normalizePhone } from '@artepool/shared';
import type {
  CreatePaymentMethodRequest,
  CreateReasonCodeRequest,
  CreateTechnicianRequest,
  CreateWarehouseRequest,
  PaymentKind,
  PaymentMethodItem,
  ReasonCategory,
  ReasonCodeItem,
  TechnicianItem,
  UpdatePaymentMethodRequest,
  UpdateReasonCodeRequest,
  UpdateTechnicianRequest,
  UpdateWarehouseRequest,
  WarehouseItem,
  WarehouseType,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { expectUpdated, fieldError } from '../../platform/db/versioned';
import { AppError } from '../../platform/errors/app-error';

const id = (value: string | null) => (value === null ? null : BigInt(value));

function found<T extends { id: string }>(list: T[], wanted: bigint, what: string): T {
  const item = list.find((x) => x.id === wanted.toString());
  if (!item) throw new AppError('NOT_FOUND', `No such ${what}`);
  return item;
}

// ---------------------------------------------------------------------------------------------
// Technicians
// ---------------------------------------------------------------------------------------------

export async function listTechnicians(db: Kysely<DB>): Promise<TechnicianItem[]> {
  const rows = await db.selectFrom('md.technicians').selectAll().orderBy('code').execute();
  return rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    phone: r.phone,
    userId: r.user_id?.toString() ?? null,
    isActive: r.is_active,
    rowVersion: r.row_version,
  }));
}

function technicianValues(body: CreateTechnicianRequest) {
  let phone: string | null = null;
  if (body.phone) {
    phone = normalizePhone(body.phone);
    if (!phone) throw fieldError('phone', 'invalid_phone');
  }
  return {
    code: body.code.toUpperCase(),
    name_ar: body.nameAr,
    name_en: body.nameEn,
    phone,
    user_id: id(body.userId),
  };
}

export async function createTechnician(trx: Transaction<DB>, body: CreateTechnicianRequest) {
  const row = await trx
    .insertInto('md.technicians')
    .values(stamped('md.technicians', technicianValues(body)))
    .returning('id')
    .executeTakeFirstOrThrow();
  return found(await listTechnicians(trx), row.id, 'technician');
}

export async function updateTechnician(
  trx: Transaction<DB>,
  techId: bigint,
  body: UpdateTechnicianRequest,
) {
  const result = await trx
    .updateTable('md.technicians')
    .set(technicianValues(body))
    .where('id', '=', techId)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.technicians', techId, result);
  return found(await listTechnicians(trx), techId, 'technician');
}

export async function setTechnicianActive(
  trx: Transaction<DB>,
  techId: bigint,
  active: boolean,
  rowVersion: number,
) {
  const result = await trx
    .updateTable('md.technicians')
    .set({ is_active: active })
    .where('id', '=', techId)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.technicians', techId, result);
  return found(await listTechnicians(trx), techId, 'technician');
}

// ---------------------------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------------------------

export async function listPaymentMethods(db: Kysely<DB>): Promise<PaymentMethodItem[]> {
  const rows = await db
    .selectFrom('md.payment_methods')
    .selectAll()
    .orderBy('sort_order')
    .orderBy('code')
    .execute();
  return rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    kind: r.kind as PaymentKind,
    glAccountId: r.gl_account_id.toString(),
    opensDrawer: r.opens_drawer,
    givesChange: r.gives_change,
    requiresReference: r.requires_reference,
    inPos: r.in_pos,
    inOffice: r.in_office,
    sortOrder: r.sort_order,
    isActive: r.is_active,
    rowVersion: r.row_version,
  }));
}

const paymentValues = (body: UpdatePaymentMethodRequest | CreatePaymentMethodRequest) => ({
  name_ar: body.nameAr,
  name_en: body.nameEn,
  gl_account_id: BigInt(body.glAccountId),
  opens_drawer: body.opensDrawer,
  gives_change: body.givesChange,
  requires_reference: body.requiresReference,
  in_pos: body.inPos,
  in_office: body.inOffice,
  sort_order: body.sortOrder,
});

export async function createPaymentMethod(trx: Transaction<DB>, body: CreatePaymentMethodRequest) {
  const row = await trx
    .insertInto('md.payment_methods')
    .values(
      stamped('md.payment_methods', {
        code: body.code.toUpperCase(),
        kind: body.kind,
        ...paymentValues(body),
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return found(await listPaymentMethods(trx), row.id, 'payment method');
}

export async function updatePaymentMethod(
  trx: Transaction<DB>,
  methodId: bigint,
  body: UpdatePaymentMethodRequest,
) {
  const result = await trx
    .updateTable('md.payment_methods')
    .set(paymentValues(body))
    .where('id', '=', methodId)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.payment_methods', methodId, result);
  return found(await listPaymentMethods(trx), methodId, 'payment method');
}

export async function setPaymentMethodActive(
  trx: Transaction<DB>,
  methodId: bigint,
  active: boolean,
  rowVersion: number,
) {
  const result = await trx
    .updateTable('md.payment_methods')
    .set({ is_active: active })
    .where('id', '=', methodId)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.payment_methods', methodId, result);
  return found(await listPaymentMethods(trx), methodId, 'payment method');
}

// ---------------------------------------------------------------------------------------------
// Warehouses
// ---------------------------------------------------------------------------------------------

export async function listWarehouses(db: Kysely<DB>): Promise<WarehouseItem[]> {
  const rows = await db.selectFrom('md.warehouses').selectAll().orderBy('code').execute();
  return rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    warehouseType: r.warehouse_type as WarehouseType,
    technicianId: r.technician_id?.toString() ?? null,
    isDefault: r.is_default,
    isActive: r.is_active,
    rowVersion: r.row_version,
  }));
}

export async function createWarehouse(trx: Transaction<DB>, body: CreateWarehouseRequest) {
  const branch = await trx
    .selectFrom('sys.branches')
    .select('id')
    .where('is_active', '=', true)
    .orderBy('id')
    .executeTakeFirstOrThrow();
  const row = await trx
    .insertInto('md.warehouses')
    .values(
      stamped('md.warehouses', {
        code: body.code.toUpperCase(),
        name_ar: body.nameAr,
        name_en: body.nameEn,
        branch_id: branch.id,
        warehouse_type: body.warehouseType,
        technician_id: id(body.technicianId),
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return found(await listWarehouses(trx), row.id, 'warehouse');
}

export async function updateWarehouse(
  trx: Transaction<DB>,
  warehouseId: bigint,
  body: UpdateWarehouseRequest,
) {
  const result = await trx
    .updateTable('md.warehouses')
    .set({
      name_ar: body.nameAr,
      name_en: body.nameEn,
      warehouse_type: body.warehouseType,
      technician_id: id(body.technicianId),
    })
    .where('id', '=', warehouseId)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.warehouses', warehouseId, result);
  return found(await listWarehouses(trx), warehouseId, 'warehouse');
}

/** The default warehouse of the branch: the mark moves from the old default (database rule). */
export async function makeDefaultWarehouse(
  trx: Transaction<DB>,
  warehouseId: bigint,
  rowVersion: number,
) {
  const result = await trx
    .updateTable('md.warehouses')
    .set({ is_default: true })
    .where('id', '=', warehouseId)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.warehouses', warehouseId, result);
  return listWarehouses(trx);
}

export async function setWarehouseActive(
  trx: Transaction<DB>,
  warehouseId: bigint,
  active: boolean,
  rowVersion: number,
) {
  const result = await trx
    .updateTable('md.warehouses')
    .set({ is_active: active })
    .where('id', '=', warehouseId)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.warehouses', warehouseId, result);
  return found(await listWarehouses(trx), warehouseId, 'warehouse');
}

// ---------------------------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------------------------

export async function listReasonCodes(db: Kysely<DB>): Promise<ReasonCodeItem[]> {
  const rows = await db
    .selectFrom('sys.reason_codes')
    .selectAll()
    .orderBy('category')
    .orderBy('code')
    .execute();
  return rows.map((r) => ({
    id: r.id.toString(),
    category: r.category as ReasonCategory,
    code: r.code,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    requiresNote: r.requires_note,
    glAccountId: r.gl_account_id?.toString() ?? null,
    isActive: r.is_active,
    rowVersion: r.row_version,
  }));
}

export async function createReasonCode(trx: Transaction<DB>, body: CreateReasonCodeRequest) {
  const row = await trx
    .insertInto('sys.reason_codes')
    .values(
      stamped('sys.reason_codes', {
        category: body.category,
        code: body.code.toUpperCase(),
        name_ar: body.nameAr,
        name_en: body.nameEn,
        requires_note: body.requiresNote,
        gl_account_id: id(body.glAccountId),
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  return found(await listReasonCodes(trx), row.id, 'reason');
}

export async function updateReasonCode(
  trx: Transaction<DB>,
  reasonId: bigint,
  body: UpdateReasonCodeRequest,
) {
  const result = await trx
    .updateTable('sys.reason_codes')
    .set({
      name_ar: body.nameAr,
      name_en: body.nameEn,
      requires_note: body.requiresNote,
      gl_account_id: id(body.glAccountId),
    })
    .where('id', '=', reasonId)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'sys.reason_codes', reasonId, result);
  return found(await listReasonCodes(trx), reasonId, 'reason');
}

export async function setReasonCodeActive(
  trx: Transaction<DB>,
  reasonId: bigint,
  active: boolean,
  rowVersion: number,
) {
  const result = await trx
    .updateTable('sys.reason_codes')
    .set({ is_active: active })
    .where('id', '=', reasonId)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'sys.reason_codes', reasonId, result);
  return found(await listReasonCodes(trx), reasonId, 'reason');
}
