/**
 * The owner's dashboard (decisions 0039, 0081). Everything is read from what already exists:
 * issued documents (credit notes count negative), payments, shifts, the ledger and the stock
 * balances. Sales are counted on their issue date in Al Ain. Cost is the cost each line was
 * valued at when it was issued (0038), so a later price change never moves past profit.
 * VAT due is the VAT on sales after returns; purchases do not exist yet, so no input VAT is taken
 * off (it will be once purchases are recorded).
 */
import { sql, type Kysely } from 'kysely';
import { quantityFromDb } from '@artepool/shared';
import type {
  DashboardFigures,
  DashboardQuery,
  DashboardResponse,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { expectedCash } from '../cash/drawer';
import { today } from '../inventory/service';
import { walkInCustomer } from '../pos/sales';

type Db = Kysely<DB>;

/** −1 for a credit note, +1 for every other issued document. */
const SIGN = sql`(CASE WHEN d.doc_type = 'credit_note' THEN -1 ELSE 1 END)`;

const day = (text: string) => new Date(`${text}T00:00:00Z`);
const text = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => text(new Date(day(date).getTime() + n * 86_400_000));
const daysBetween = (from: string, to: string) =>
  Math.round((day(to).getTime() - day(from).getTime()) / 86_400_000) + 1;

/** The period's first and last day: weeks start on Monday (UAE working week). */
export function periodRange(
  query: DashboardQuery,
  todayText: string,
): { from: string; to: string } {
  const now = day(todayText);
  switch (query.period) {
    case 'custom':
      return { from: query.from!, to: query.to! };
    case 'week':
      return { from: addDays(todayText, -((now.getUTCDay() + 6) % 7)), to: todayText };
    case 'month':
      return { from: `${todayText.slice(0, 7)}-01`, to: todayText };
    case 'year':
      return { from: `${todayText.slice(0, 4)}-01-01`, to: todayText };
    default:
      return { from: todayText, to: todayText };
  }
}

async function figures(db: Db, from: string, to: string): Promise<DashboardFigures> {
  const { rows } = await sql<{
    total: string;
    net: string;
    vat: string;
    cost: string;
    n: number;
  }>`SELECT coalesce(sum(${SIGN} * d.total_fils), 0)::text AS total,
            coalesce(sum(${SIGN} * d.net_fils), 0)::text AS net,
            coalesce(sum(${SIGN} * d.vat_fils), 0)::text AS vat,
            coalesce(sum(${SIGN} * d.cost_fils), 0)::text AS cost,
            count(*) FILTER (WHERE d.doc_type <> 'credit_note')::int AS n
       FROM sales.documents d
      WHERE d.status = 'issued' AND d.issue_date BETWEEN ${from}::date AND ${to}::date`.execute(db);
  const r = rows[0]!;
  return {
    totalFils: r.total,
    netFils: r.net,
    vatFils: r.vat,
    costFils: r.cost,
    profitFils: (BigInt(r.net) - BigInt(r.cost)).toString(),
    documents: r.n,
  };
}

export async function ownerDashboard(db: Db, query: DashboardQuery): Promise<DashboardResponse> {
  const todayText = await today(db);
  const { from, to } = periodRange(query, todayText);
  const length = daysBetween(from, to);
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(from, -length);
  const inPeriod = sql`d.status = 'issued' AND d.issue_date BETWEEN ${from}::date AND ${to}::date`;

  const daily = await sql<{ date: string; total: string; profit: string }>`
    SELECT d.issue_date::text AS date,
           sum(${SIGN} * d.total_fils)::text AS total,
           sum(${SIGN} * (d.net_fils - d.cost_fils))::text AS profit
      FROM sales.documents d WHERE ${inPeriod}
     GROUP BY d.issue_date ORDER BY d.issue_date`.execute(db);

  const channel = await sql<{ pos: string; a4: string; unpaid: string }>`
    SELECT coalesce(sum(${SIGN} * d.total_fils) FILTER (WHERE d.channel = 'pos'), 0)::text AS pos,
           coalesce(sum(${SIGN} * d.total_fils) FILTER (WHERE d.channel <> 'pos'), 0)::text AS a4,
           coalesce(sum(d.total_fils - d.settled_fils)
                    FILTER (WHERE d.doc_type IN ('invoice', 'debit_note')), 0)::text AS unpaid
      FROM sales.documents d WHERE ${inPeriod}`.execute(db);

  const methods = await sql<{
    id: string;
    kind: string;
    name_ar: string;
    name_en: string;
    amount: string;
  }>`SELECT m.id::text, m.kind, m.name_ar, m.name_en,
            sum(CASE WHEN p.direction = 'in' THEN p.amount_fils ELSE -p.amount_fils END)::text AS amount
       FROM sales.payments p JOIN md.payment_methods m ON m.id = p.payment_method_id
      WHERE p.payment_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY m.id ORDER BY m.sort_order, m.id`.execute(db);

  const cashiers = await sql<{
    id: string;
    name_ar: string;
    name_en: string;
    total: string;
    n: number;
  }>`SELECT u.id::text, u.display_name_ar AS name_ar, u.display_name_en AS name_en,
            sum(${SIGN} * d.total_fils)::text AS total,
            count(*) FILTER (WHERE d.doc_type <> 'credit_note')::int AS n
       FROM sales.documents d JOIN auth.users u ON u.id = d.issued_by
      WHERE ${inPeriod}
      GROUP BY u.id ORDER BY sum(${SIGN} * d.total_fils) DESC`.execute(db);

  const items = await sql<{
    id: string;
    code: string;
    name_ar: string;
    name_en: string;
    qty: string;
    net: string;
    profit: string;
  }>`SELECT i.id::text, i.code, i.name_ar, i.name_en,
            sum(${SIGN} * l.quantity)::text AS qty,
            sum(${SIGN} * l.net_fils)::text AS net,
            sum(${SIGN} * (l.net_fils - l.cost_fils))::text AS profit
       FROM sales.document_lines l
       JOIN sales.documents d ON d.id = l.document_id
       JOIN md.items i ON i.id = l.item_id
      WHERE ${inPeriod} AND l.line_kind = 'item'
      GROUP BY i.id ORDER BY sum(${SIGN} * l.net_fils) DESC LIMIT 10`.execute(db);

  const walkIn = await walkInCustomer(db);
  const customers = await sql<{ id: string; name: string; total: string }>`
    SELECT c.id::text, c.name, sum(${SIGN} * d.total_fils)::text AS total
      FROM sales.documents d JOIN md.customers c ON c.id = d.customer_id
     WHERE ${inPeriod} AND d.customer_id <> ${walkIn}
     GROUP BY c.id ORDER BY sum(${SIGN} * d.total_fils) DESC LIMIT 10`.execute(db);

  // Cash now: the open drawers, the safe (its ledger account), and the period's over/short.
  const open = await db
    .selectFrom('cash.shifts as s')
    .innerJoin('cash.registers as r', 'r.id', 's.register_id')
    .innerJoin('auth.users as u', 'u.id', 's.cashier_id')
    .select(['s.id', 's.shift_number', 'r.code', 'u.display_name_ar', 'u.display_name_en'])
    .where('s.status', '=', 'open')
    .orderBy('r.code')
    .execute();
  const openShifts = await Promise.all(
    open.map(async (s) => ({
      shiftId: s.id.toString(),
      shiftNumber: s.shift_number,
      registerCode: s.code,
      nameAr: s.display_name_ar,
      nameEn: s.display_name_en,
      expectedFils: (await expectedCash(db, s.id)).toString(),
    })),
  );
  const safe = await sql<{ v: string }>`
    SELECT coalesce(sum(jl.debit_fils - jl.credit_fils), 0)::text AS v
      FROM gl.journal_lines jl
     WHERE jl.account_id = (SELECT account_id FROM gl.account_mappings WHERE key = 'cash_in_safe')`.execute(
    db,
  );
  const variance = await sql<{ v: string }>`
    SELECT coalesce(sum(variance_fils), 0)::text AS v FROM cash.shifts
     WHERE status = 'closed' AND sys.business_date(closed_at) BETWEEN ${from}::date AND ${to}::date`.execute(
    db,
  );

  // Receivables: what customers owe now, and how much of it is past its due date.
  const owed = await sql<{ id: string; name: string; balance: string; overdue: string }>`
    SELECT c.id::text, c.name, b.balance::text,
           coalesce((SELECT sum(d.total_fils - d.settled_fils) FROM sales.documents d
                      WHERE d.customer_id = c.id AND d.status = 'issued'
                        AND d.doc_type IN ('invoice', 'debit_note')
                        AND d.due_date < ${todayText}::date), 0)::text AS overdue
      FROM md.customers c
      CROSS JOIN LATERAL (SELECT sales.customer_balance(c.id) AS balance) b
     WHERE b.balance > 0
     ORDER BY b.balance DESC`.execute(db);
  const owedTotal = owed.rows.reduce((sum, r) => sum + BigInt(r.balance), 0n);
  const overdueTotal = owed.rows.reduce((sum, r) => sum + BigInt(r.overdue), 0n);

  // Stock: its value at cost, and the items at or under their reorder level.
  const value = await sql<{ v: string }>`
    SELECT coalesce(sum(book_value_fils), 0)::text AS v FROM inv.balances`.execute(db);
  const low = await sql<{
    id: string;
    code: string;
    name_ar: string;
    name_en: string;
    on_hand: string;
    reorder: string;
  }>`SELECT i.id::text, i.code, i.name_ar, i.name_en,
            coalesce((SELECT sum(b.quantity) FROM inv.balances b
                       WHERE b.item_id = i.id AND b.stock_status = 'available'), 0)::text AS on_hand,
            i.reorder_level::text AS reorder
       FROM md.items i
      WHERE i.item_type = 'stock' AND i.is_active AND i.reorder_level IS NOT NULL
        AND coalesce((SELECT sum(b.quantity) FROM inv.balances b
                       WHERE b.item_id = i.id AND b.stock_status = 'available'), 0) <= i.reorder_level
      ORDER BY i.code`.execute(db);

  return {
    from,
    to,
    previousFrom,
    previousTo,
    current: await figures(db, from, to),
    previous: await figures(db, previousFrom, previousTo),
    daily: daily.rows.map((r) => ({ date: r.date, totalFils: r.total, profitFils: r.profit })),
    byChannel: { posFils: channel.rows[0]!.pos, a4Fils: channel.rows[0]!.a4 },
    byMethod: methods.rows.map((m) => ({
      methodId: m.id,
      kind: m.kind,
      nameAr: m.name_ar,
      nameEn: m.name_en,
      amountFils: m.amount,
    })),
    unpaidFils: channel.rows[0]!.unpaid,
    byCashier: cashiers.rows.map((c) => ({
      userId: c.id,
      nameAr: c.name_ar,
      nameEn: c.name_en,
      totalFils: c.total,
      documents: c.n,
    })),
    topItems: items.rows.map((i) => ({
      itemId: i.id,
      code: i.code,
      nameAr: i.name_ar,
      nameEn: i.name_en,
      quantityMilli: quantityFromDb(i.qty).toString(),
      netFils: i.net,
      profitFils: i.profit,
    })),
    topCustomers: customers.rows.map((c) => ({
      customerId: c.id,
      name: c.name,
      totalFils: c.total,
    })),
    cash: {
      openShifts,
      drawersFils: openShifts.reduce((sum, s) => sum + BigInt(s.expectedFils), 0n).toString(),
      safeFils: safe.rows[0]!.v,
      varianceFils: variance.rows[0]!.v,
    },
    receivables: {
      totalFils: owedTotal.toString(),
      overdueFils: overdueTotal.toString(),
      customers: owed.rows.slice(0, 10).map((r) => ({
        customerId: r.id,
        name: r.name,
        balanceFils: r.balance,
        overdueFils: r.overdue,
      })),
    },
    stock: {
      valueFils: value.rows[0]!.v,
      toReorder: low.rows.length,
      items: low.rows.slice(0, 10).map((i) => ({
        itemId: i.id,
        code: i.code,
        nameAr: i.name_ar,
        nameEn: i.name_en,
        onHandMilli: quantityFromDb(i.on_hand).toString(),
        reorderLevelMilli: quantityFromDb(i.reorder).toString(),
      })),
    },
  };
}
