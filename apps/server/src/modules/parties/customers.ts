/**
 * Customers (design 14). Every customer has a type (individual / contractor / company; reports
 * only, never VAT — decision 0032), a unique phone and, when VAT-registered, a unique TRN
 * (decision 0037). New customers start as cash; credit is set separately with
 * `customers.credit` and a reason, which the database enforces too (decision 0036).
 */
import { matchesWords } from '../../platform/db/search';
import { sql, type Kysely, type Transaction } from 'kysely';
import { normalizePhone, normalizeTrn } from '@artepool/shared';
import type {
  CreateCustomerRequest,
  CreditMode,
  CustomerDetail,
  CustomerListItem,
  CustomersQuery,
  CustomersResponse,
  CustomerType,
  Emirate,
  SetCustomerCreditRequest,
  UpdateCustomerRequest,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { expectUpdated, fieldError } from '../../platform/db/versioned';
import { AppError, ruleError } from '../../platform/errors/app-error';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** The database gives the next free code when none is sent (C00001…, S00001…). */
const NEXT_CODE = sql<string>`NULL`;

function listItem(r: {
  id: bigint;
  code: string;
  customer_type: string;
  name: string;
  name_alt: string | null;
  phone: string | null;
  is_vat_registered: boolean;
  trn: string | null;
  credit_mode: string;
  is_walk_in: boolean;
  is_active: boolean;
}): CustomerListItem {
  return {
    id: r.id.toString(),
    code: r.code,
    customerType: r.customer_type as CustomerType,
    name: r.name,
    nameAlt: r.name_alt,
    phone: r.phone,
    isVatRegistered: r.is_vat_registered,
    trn: r.trn,
    creditMode: r.credit_mode as CreditMode,
    isWalkIn: r.is_walk_in,
    isActive: r.is_active,
  };
}

export async function listCustomers(
  db: Kysely<DB>,
  query: CustomersQuery,
): Promise<CustomersResponse> {
  let base = db.selectFrom('md.customers');
  if (query.status !== 'all') base = base.where('is_active', '=', query.status === 'active');
  if (query.vat) base = base.where('is_vat_registered', '=', query.vat === 'registered');
  if (query.q) {
    const q = query.q;
    const phone = normalizePhone(q);
    base = base.where((eb) =>
      eb.or([
        matchesWords('search_key', q),
        ...(phone ? [eb('phone', '=', phone), eb('phone_alt', '=', phone)] : []),
      ]),
    );
  }
  const total = await base
    .select((eb) => eb.fn.countAll<bigint>().as('n'))
    .executeTakeFirstOrThrow();
  const rows = await base
    .selectAll()
    .orderBy('is_walk_in', 'desc')
    .orderBy('name')
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .execute();
  const counts = await db
    .selectFrom('md.customers')
    .select([
      sql<number>`count(*) FILTER (WHERE is_active)::int`.as('active'),
      sql<number>`count(*) FILTER (WHERE is_active AND is_vat_registered)::int`.as('vat'),
    ])
    .executeTakeFirstOrThrow();
  return {
    total: Number(total.n),
    customers: rows.map(listItem),
    counts: { active: counts.active, vatRegistered: counts.vat },
  };
}

export async function getCustomer(db: Kysely<DB>, id: bigint): Promise<CustomerDetail> {
  const r = await db.selectFrom('md.customers').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) throw new AppError('NOT_FOUND', 'No such customer');
  return {
    ...listItem(r),
    phoneAlt: r.phone_alt,
    email: r.email,
    addressLine: r.address_line,
    area: r.area,
    city: r.city,
    poBox: r.po_box,
    emirate: r.emirate as Emirate | null,
    countryCode: r.country_code,
    paymentTermsDays: r.payment_terms_days,
    creditLimitFils: r.credit_limit_fils.toString(),
    preferredLanguage: r.preferred_language as 'ar' | 'en' | null,
    notes: r.notes,
    rowVersion: r.row_version,
  };
}

/** Phone, TRN and e-mail as stored, or the field that is not valid. */
export function customerValues(body: CreateCustomerRequest) {
  const phone = normalizePhone(body.phone);
  if (!phone) throw fieldError('phone', 'invalid_phone');
  let phoneAlt: string | null = null;
  if (body.phoneAlt) {
    phoneAlt = normalizePhone(body.phoneAlt);
    if (!phoneAlt) throw fieldError('phoneAlt', 'invalid_phone');
  }
  let trn: string | null = null;
  if (body.isVatRegistered) {
    trn = body.trn ? normalizeTrn(body.trn) : null;
    if (!trn) throw fieldError('trn', 'invalid_trn');
  }
  if (body.email && !EMAIL.test(body.email)) throw fieldError('email', 'invalid_email');
  return {
    customer_type: body.customerType,
    name: body.name,
    name_alt: body.nameAlt ?? null,
    phone,
    phone_alt: phoneAlt,
    email: body.email ?? null,
    address_line: body.addressLine ?? null,
    area: body.area ?? null,
    city: body.city ?? null,
    po_box: body.poBox ?? null,
    emirate: body.emirate ?? null,
    is_vat_registered: body.isVatRegistered,
    trn,
    preferred_language: body.preferredLanguage ?? null,
    notes: body.notes ?? null,
  };
}

/** A new customer, always as cash (decision 0036). */
export async function createCustomer(
  trx: Transaction<DB>,
  body: CreateCustomerRequest,
): Promise<CustomerDetail> {
  const row = await trx
    .insertInto('md.customers')
    .values(stamped('md.customers', { code: NEXT_CODE, ...customerValues(body) }))
    .returning('id')
    .executeTakeFirstOrThrow();
  return getCustomer(trx, row.id);
}

async function refuseWalkIn(db: Kysely<DB>, id: bigint): Promise<void> {
  const row = await db
    .selectFrom('md.customers')
    .select('is_walk_in')
    .where('id', '=', id)
    .executeTakeFirst();
  if (row?.is_walk_in) {
    throw ruleError('WALK_IN_LOCKED', 'The walk-in customer cannot be changed');
  }
}

export async function updateCustomer(
  trx: Transaction<DB>,
  id: bigint,
  body: UpdateCustomerRequest,
): Promise<CustomerDetail> {
  await refuseWalkIn(trx, id);
  const result = await trx
    .updateTable('md.customers')
    .set(customerValues(body))
    .where('id', '=', id)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.customers', id, result);
  return getCustomer(trx, id);
}

/** Cash, or credit with a limit and terms; the reason is in the request context (decision 0036). */
export async function setCustomerCredit(
  trx: Transaction<DB>,
  id: bigint,
  body: SetCustomerCreditRequest,
): Promise<CustomerDetail> {
  await refuseWalkIn(trx, id);
  const credit = body.credit;
  const result = await trx
    .updateTable('md.customers')
    .set(
      credit.mode === 'cash'
        ? { credit_mode: 'cash', credit_limit_fils: 0n, payment_terms_days: 0 }
        : {
            credit_mode: 'credit',
            credit_limit_fils: BigInt(credit.creditLimitFils),
            payment_terms_days: credit.paymentTermsDays,
          },
    )
    .where('id', '=', id)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.customers', id, result);
  return getCustomer(trx, id);
}

export async function setCustomerActive(
  trx: Transaction<DB>,
  id: bigint,
  active: boolean,
  rowVersion: number,
): Promise<CustomerDetail> {
  await refuseWalkIn(trx, id);
  const result = await trx
    .updateTable('md.customers')
    .set({ is_active: active })
    .where('id', '=', id)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.customers', id, result);
  return getCustomer(trx, id);
}
