/**
 * Customer opening balances (decision 0051: once per customer, owner only, posting map row 20),
 * the statement of account for any dates, and what a customer owes right now.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  OpeningBalanceItem,
  OpeningBalanceRequest,
  StatementLine,
  StatementQuery,
  StatementResponse,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { filledByDatabase } from '../../platform/db/stamped';
import { today } from '../inventory/service';
import { postEntry } from '../ledger/posting';
import { openingBalancePosting } from '../ledger/sales-posting';
import { advancesOf, outstandingOf } from './balance';

type Db = Kysely<DB> | Transaction<DB>;

const openingItem = (r: {
  id: bigint;
  customer_id: bigint;
  balance_date: string;
  direction: string;
  amount_fils: bigint;
  settled_fils: bigint;
  reference: string | null;
}): OpeningBalanceItem => ({
  id: r.id.toString(),
  customerId: r.customer_id.toString(),
  balanceDate: r.balance_date,
  direction: r.direction as OpeningBalanceItem['direction'],
  amountFils: r.amount_fils.toString(),
  settledFils: r.settled_fils.toString(),
  reference: r.reference,
});

export async function addOpeningBalance(
  trx: Transaction<DB>,
  body: OpeningBalanceRequest,
  importBatchId: bigint | null = null,
): Promise<OpeningBalanceItem> {
  const date = body.balanceDate ?? (await today(trx));
  const row = await trx
    .insertInto('sales.opening_balances')
    .values(
      filledByDatabase('sales.opening_balances', {
        customer_id: BigInt(body.customerId),
        balance_date: date,
        direction: body.direction,
        amount_fils: BigInt(body.amountFils),
        reference: body.reference ?? null,
        due_date: body.dueDate ?? null,
        import_batch_id: importBatchId,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  await postEntry(trx, {
    date,
    source: { type: 'opening_balance', id: row.id },
    amounts: openingBalancePosting({
      customerId: row.customer_id,
      direction: body.direction,
      amountFils: row.amount_fils,
    }),
  });
  return openingItem(row);
}

export async function openingBalanceOf(
  db: Db,
  customerId: bigint,
): Promise<OpeningBalanceItem | null> {
  const row = await db
    .selectFrom('sales.opening_balances')
    .selectAll()
    .where('customer_id', '=', customerId)
    .executeTakeFirst();
  return row ? openingItem(row) : null;
}

/** Everything that moved the customer's balance, in date order, signed from the customer's side. */
function movements(db: Db, customerId: bigint) {
  return sql<{
    date: string;
    kind: string;
    id: string;
    doc_number: string | null;
    amount: string;
    seq: string;
  }>`
    SELECT issue_date::text AS date, doc_type AS kind, id::text, doc_number,
           (CASE WHEN doc_type = 'credit_note' THEN -total_fils ELSE total_fils END)::text AS amount,
           ('d' || lpad(id::text, 19, '0')) AS seq
      FROM sales.documents
     WHERE customer_id = ${customerId} AND status = 'issued'
    UNION ALL
    SELECT p.payment_date::text, p.payment_kind, p.id::text, p.doc_number,
           (CASE WHEN p.payment_kind = 'receipt' THEN -p.amount_fils
                 WHEN p.payment_kind = 'refund' THEN p.amount_fils
                 WHEN o.payment_kind = 'receipt' THEN p.amount_fils
                 ELSE -p.amount_fils END)::text,
           ('p' || lpad(p.id::text, 19, '0'))
      FROM sales.payments p LEFT JOIN sales.payments o ON o.id = p.reversal_of_id
     WHERE p.customer_id = ${customerId}
    UNION ALL
    SELECT balance_date::text, 'opening_balance', id::text, reference,
           (CASE WHEN direction = 'receivable' THEN amount_fils ELSE -amount_fils END)::text,
           ('a' || lpad(id::text, 19, '0'))
      FROM sales.opening_balances
     WHERE customer_id = ${customerId}`;
}

export async function statement(
  db: Db,
  customerId: bigint,
  query: StatementQuery,
): Promise<StatementResponse> {
  const { rows } = await sql<{
    date: string;
    kind: string;
    id: string;
    doc_number: string | null;
    amount: string;
  }>`SELECT * FROM (${movements(db, customerId)}) m ORDER BY date, seq`.execute(db);
  let opening = 0n;
  let balance = 0n;
  const lines: StatementLine[] = [];
  for (const r of rows) {
    const amount = BigInt(r.amount);
    if (r.date < query.from) {
      opening += amount;
      balance += amount;
      continue;
    }
    if (r.date > query.to) break;
    balance += amount;
    lines.push({
      date: r.date,
      kind: r.kind as StatementLine['kind'],
      id: r.id,
      docNumber: r.doc_number,
      debitFils: (amount > 0n ? amount : 0n).toString(),
      creditFils: (amount < 0n ? -amount : 0n).toString(),
      balanceFils: balance.toString(),
    });
  }
  // Decision 0114: today's net position (advance payments apart, never netted in the lines).
  const id = sql<bigint>`${customerId}::bigint`;
  const now = (
    await sql<{ outstanding: string; advances: string }>`
      SELECT ${outstandingOf(id)} AS outstanding, ${advancesOf(id)} AS advances`.execute(db)
  ).rows[0]!;
  const outstanding = BigInt(now.outstanding);
  const advances = BigInt(now.advances);
  return {
    customerId: customerId.toString(),
    from: query.from,
    to: query.to,
    openingFils: opening.toString(),
    lines,
    closingFils: balance.toString(),
    today: {
      outstandingFils: outstanding.toString(),
      advancesFils: advances.toString(),
      netPositionFils: (outstanding - advances).toString(),
    },
  };
}
