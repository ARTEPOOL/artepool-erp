/**
 * The customer's balance (decision 0114), from posted documents only, never typed: outstanding
 * (the same number the credit-limit rule uses, 0046), overdue (past the due date, 0113, opening
 * balances included), advance payments not yet deducted (apart, never subtracted), and the status
 * that colours the banner. The amounts and the open debts go only to customers.balance.view.
 */
import { sql, type Expression, type Kysely, type Transaction } from 'kysely';
import { balanceStatus } from '@artepool/shared';
import type { CustomerBalance, OpenDebtLine } from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { AppError } from '../../platform/errors/app-error';
import { OVERDUE } from './documents';

type Db = Kysely<DB> | Transaction<DB>;

/** What the customer owes (negative: is owed): open documents, credit notes, opening balances. */
export const outstandingOf = (customer: Expression<bigint>) =>
  sql<string>`sales.customer_balance(${customer})::text`;

/** The part of it past its due date. */
export const overdueOf = (customer: Expression<bigint>) =>
  sql<string>`(coalesce((SELECT sum(d.total_fils - d.settled_fils) FROM sales.documents d
                          WHERE d.customer_id = ${customer} AND ${OVERDUE}), 0)
             + coalesce((SELECT sum(o.amount_fils - o.settled_fils) FROM sales.opening_balances o
                          WHERE o.customer_id = ${customer} AND o.direction = 'receivable'
                            AND o.due_date IS NOT NULL AND o.due_date < sys.business_date(now())
                            AND o.settled_fils < o.amount_fils), 0))::text`;

/** Advance payments not yet deducted (payment tax invoices, with VAT, 0013). */
export const advancesOf = (customer: Expression<bigint>) =>
  sql<string>`(SELECT coalesce(sum(a.net_fils - a.advance_used_net_fils
                                   + a.vat_fils - a.advance_used_vat_fils), 0)
                 FROM sales.documents a
                WHERE a.customer_id = ${customer} AND a.doc_type = 'advance_invoice'
                  AND a.status = 'issued')::text`;

export async function customerBalance(
  db: Db,
  customerId: bigint,
  opts: { amounts: boolean; detail?: boolean },
): Promise<CustomerBalance> {
  const id = sql<bigint>`${customerId}::bigint`;
  const c = await db
    .selectFrom('md.customers')
    .select([
      'credit_mode',
      'credit_limit_fils',
      'is_walk_in',
      outstandingOf(id).as('outstanding'),
      overdueOf(id).as('overdue'),
      advancesOf(id).as('advances'),
    ])
    .where('id', '=', customerId)
    .executeTakeFirst();
  if (!c) throw new AppError('NOT_FOUND', 'No such customer');
  const limit = c.credit_mode === 'credit' ? c.credit_limit_fils : 0n;
  const outstanding = BigInt(c.outstanding);
  const overdue = BigInt(c.overdue);
  const advances = BigInt(c.advances);
  const result: CustomerBalance = {
    status: balanceStatus({
      outstandingFils: outstanding,
      overdueFils: overdue,
      creditLimitFils: limit,
    }),
    creditMode: c.credit_mode as CustomerBalance['creditMode'],
    isWalkIn: c.is_walk_in,
    amounts: opts.amounts
      ? {
          outstandingFils: outstanding.toString(),
          overdueFils: overdue.toString(),
          creditLimitFils: limit.toString(),
          availableFils: (limit - outstanding).toString(),
          advancesFils: advances.toString(),
          netPositionFils: (outstanding - advances).toString(),
        }
      : null,
  };
  if (opts.amounts && opts.detail) {
    result.openDebts = await openDebtLines(db, customerId);
    result.oldestUnpaidDate = result.openDebts[0]?.date ?? null;
  }
  return result;
}

/** What is still owed, oldest first, with its age and days overdue. */
async function openDebtLines(db: Db, customerId: bigint): Promise<OpenDebtLine[]> {
  const { rows } = await sql<{
    kind: OpenDebtLine['kind'];
    document_id: string | null;
    doc_number: string | null;
    date: string;
    due_date: string | null;
    total: string;
    due: string;
    age: number;
    late: number;
  }>`
    WITH today AS (SELECT sys.business_date(now()) AS d)
    SELECT 'opening_balance' AS kind, NULL::text AS document_id, o.reference AS doc_number,
           o.balance_date::text AS date, o.due_date::text AS due_date,
           o.amount_fils::text AS total, (o.amount_fils - o.settled_fils)::text AS due,
           (today.d - o.balance_date)::int AS age,
           greatest(0, coalesce(today.d - o.due_date, 0))::int AS late, 0 AS seq
      FROM sales.opening_balances o, today
     WHERE o.customer_id = ${customerId} AND o.direction = 'receivable'
       AND o.settled_fils < o.amount_fils
    UNION ALL
    SELECT d.doc_type, d.id::text, d.doc_number, d.issue_date::text, d.due_date::text,
           d.total_fils::text, (d.total_fils - d.settled_fils)::text,
           (today.d - d.issue_date)::int,
           greatest(0, coalesce(today.d - d.due_date, 0))::int, d.id
      FROM sales.documents d, today
     WHERE d.customer_id = ${customerId} AND d.status = 'issued'
       AND d.doc_type IN ('invoice', 'debit_note') AND d.settled_fils < d.total_fils
     ORDER BY date, seq`.execute(db);
  return rows.map((r) => ({
    kind: r.kind,
    documentId: r.document_id,
    docNumber: r.doc_number,
    date: r.date,
    dueDate: r.due_date,
    totalFils: r.total,
    dueFils: r.due,
    ageDays: r.age,
    daysOverdue: r.late,
  }));
}
