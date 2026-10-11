/** Suppliers (purchasing comes in P2). TRN 15 digits starting with 100, unique (decision 0037). */
import { sql, type Kysely, type Transaction } from 'kysely';
import { normalizePhone, normalizeTrn } from '@artepool/shared';
import type {
  CreateSupplierRequest,
  Emirate,
  ListQuery,
  SupplierDetail,
  SupplierListItem,
  SuppliersResponse,
  UpdateSupplierRequest,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { expectUpdated, fieldError } from '../../platform/db/versioned';
import { AppError } from '../../platform/errors/app-error';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** The database gives the next free code when none is sent (C00001…, S00001…). */
const NEXT_CODE = sql<string>`NULL`;

const listItem = (r: {
  id: bigint;
  code: string;
  name: string;
  name_alt: string | null;
  phone: string | null;
  is_vat_registered: boolean;
  trn: string | null;
  payment_terms_days: number;
  is_active: boolean;
}): SupplierListItem => ({
  id: r.id.toString(),
  code: r.code,
  name: r.name,
  nameAlt: r.name_alt,
  phone: r.phone,
  isVatRegistered: r.is_vat_registered,
  trn: r.trn,
  paymentTermsDays: r.payment_terms_days,
  isActive: r.is_active,
});

export async function listSuppliers(db: Kysely<DB>, query: ListQuery): Promise<SuppliersResponse> {
  let base = db.selectFrom('md.suppliers');
  if (query.status !== 'all') base = base.where('is_active', '=', query.status === 'active');
  if (query.q) {
    const q = query.q;
    base = base.where(sql<boolean>`search_key LIKE '%' || sys.normalize_search(${q}) || '%'`);
  }
  const total = await base
    .select((eb) => eb.fn.countAll<bigint>().as('n'))
    .executeTakeFirstOrThrow();
  const rows = await base
    .selectAll()
    .orderBy('name')
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .execute();
  return { total: Number(total.n), suppliers: rows.map(listItem) };
}

export async function getSupplier(db: Kysely<DB>, id: bigint): Promise<SupplierDetail> {
  const r = await db.selectFrom('md.suppliers').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) throw new AppError('NOT_FOUND', 'No such supplier');
  return {
    ...listItem(r),
    email: r.email,
    addressLine: r.address_line,
    city: r.city,
    emirate: r.emirate as Emirate | null,
    countryCode: r.country_code,
    notes: r.notes,
    rowVersion: r.row_version,
  };
}

function supplierValues(body: CreateSupplierRequest) {
  let phone: string | null = null;
  if (body.phone) {
    phone = normalizePhone(body.phone);
    if (!phone) throw fieldError('phone', 'invalid_phone');
  }
  let trn: string | null = null;
  if (body.isVatRegistered) {
    trn = body.trn ? normalizeTrn(body.trn) : null;
    if (!trn) throw fieldError('trn', 'invalid_trn');
  }
  if (body.email && !EMAIL.test(body.email)) throw fieldError('email', 'invalid_email');
  return {
    name: body.name,
    name_alt: body.nameAlt ?? null,
    phone,
    email: body.email ?? null,
    address_line: body.addressLine ?? null,
    city: body.city ?? null,
    emirate: body.emirate ?? null,
    country_code: body.countryCode,
    is_vat_registered: body.isVatRegistered,
    trn,
    payment_terms_days: body.paymentTermsDays,
    notes: body.notes ?? null,
  };
}

export async function createSupplier(
  trx: Transaction<DB>,
  body: CreateSupplierRequest,
): Promise<SupplierDetail> {
  const row = await trx
    .insertInto('md.suppliers')
    .values(stamped('md.suppliers', { code: NEXT_CODE, ...supplierValues(body) }))
    .returning('id')
    .executeTakeFirstOrThrow();
  return getSupplier(trx, row.id);
}

export async function updateSupplier(
  trx: Transaction<DB>,
  id: bigint,
  body: UpdateSupplierRequest,
): Promise<SupplierDetail> {
  const result = await trx
    .updateTable('md.suppliers')
    .set(supplierValues(body))
    .where('id', '=', id)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.suppliers', id, result);
  return getSupplier(trx, id);
}

export async function setSupplierActive(
  trx: Transaction<DB>,
  id: bigint,
  active: boolean,
  rowVersion: number,
): Promise<SupplierDetail> {
  const result = await trx
    .updateTable('md.suppliers')
    .set({ is_active: active })
    .where('id', '=', id)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.suppliers', id, result);
  return getSupplier(trx, id);
}
