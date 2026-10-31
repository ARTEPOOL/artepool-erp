/**
 * Customers (design 14). Every customer has a type (individual / contractor / company; reports
 * only, never VAT — decision 0032), a unique phone and, when VAT-registered, a unique TRN
 * (decision 0037). New customers start as cash; credit is set separately with
 * `customers.credit` and a reason, which the database enforces too (decision 0036).
 */
import { matchesWords } from '../../platform/db/search';
import { sql, type Kysely, type Transaction } from 'kysely';
import { balanceStatus, normalizePhone, normalizeTrn } from '@artepool/shared';
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
import { outstandingOf, overdueOf } from '../sales/balance';

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
  /** Decision 0114: balance amounts (customers.balance.view). */
  canSeeAmounts = false,
): Promise<CustomersResponse> {
  if (query.sort === 'outstanding' && !canSeeAmounts) {
    throw new AppError('PERMISSION_DENIED', 'Missing permission customers.balance.view', {
      permission: 'customers.balance.view',
    });
  }
  let base = db.selectFrom('md.customers');
  // Decision 0114: only customers with something past its due date.
  if (query.overdue === 'yes')
    base = base.where(sql<boolean>`${overdueOf(sql.ref('md.customers.id'))}::bigint > 0`);
  if (query.status !== 'all') base = base.where('is_active', '=', query.status === 'active');
  if (query.vat) base = base.where('is_vat_registered', '=', query.vat === 'registered');
  if (query.q) {
    const q = query.q;
    const phone = normalizePhone(q);
    // A phone number is matched as a phone; anything else by its words, in any order.
    base = base.where((eb) =>
      phone
        ? eb.or([eb('phone', '=', phone), eb('phone_alt', '=', phone)])
        : matchesWords('search_key', q),
    );
  }
  const total = await base
    .select((eb) => eb.fn.countAll<bigint>().as('n'))
    .executeTakeFirstOrThrow();
  const withBalance = query.balance === 'yes' || query.sort === 'outstanding';
  // Only when asked: the customer search (pickers) stays cheap.
  const zero = sql<string>`NULL::text`;
  let ordered = base
    .selectAll()
    .select([
      (withBalance ? outstandingOf(sql.ref('md.customers.id')) : zero).as('outstanding'),
      (withBalance ? overdueOf(sql.ref('md.customers.id')) : zero).as('overdue'),
    ]);
  ordered =
    query.sort === 'outstanding'
      ? ordered.orderBy(sql`sales.customer_balance(md.customers.id)`, 'desc').orderBy('name')
      : ordered.orderBy('is_walk_in', 'desc').orderBy('name');
  const rows = await ordered
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
    customers: rows.map((r) => {
      const item = listItem(r);
      if (!withBalance) return item;
      const outstanding = BigInt(r.outstanding ?? '0');
      const overdue = BigInt(r.overdue ?? '0');
      const limit = r.credit_mode === 'credit' ? r.credit_limit_fils : 0n;
      item.balance = {
        status: balanceStatus({
          outstandingFils: outstanding,
          overdueFils: overdue,
          creditLimitFils: limit,
        }),
        outstandingFils: canSeeAmounts ? outstanding.toString() : null,
        overdueFils: canSeeAmounts ? overdue.toString() : null,
      };
      return item;
    }),
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
