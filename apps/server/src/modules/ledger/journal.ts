/** The journal viewer and the trial balance (ledger.view). Entries are read-only by design. */
import { sql, type Kysely } from 'kysely';
import type {
  JournalEntryDetail,
  JournalEntryItem,
  JournalQuery,
  JournalResponse,
  JournalSource,
  TrialBalanceQuery,
  TrialBalanceResponse,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { AppError } from '../../platform/errors/app-error';

function entryBase(db: Kysely<DB>) {
  return db
    .selectFrom('gl.journal_entries as e')
    .leftJoin('inv.adjustments as a', 'a.id', 'e.inventory_adjustment_id')
    .leftJoin('inv.counts as c', 'c.id', 'e.inventory_count_id')
    .innerJoin('auth.users as u', 'u.id', 'e.posted_by')
    .select([
      'e.id',
      'e.entry_number',
      'e.entry_date',
      'e.source_type',
      'e.memo',
      'e.total_debit_fils',
      'e.posted_at',
      'e.posted_by',
      'u.display_name_ar',
      'u.display_name_en',
      'a.id as adjustment_id',
      'a.doc_number as adjustment_number',
      'c.id as count_id',
      'c.doc_number as count_number',
    ]);
}

type EntryRow = Awaited<ReturnType<ReturnType<typeof entryBase>['executeTakeFirstOrThrow']>>;

const entryItem = (r: EntryRow): JournalEntryItem => ({
  id: r.id.toString(),
  entryNumber: r.entry_number,
  entryDate: r.entry_date,
  sourceType: r.source_type as JournalSource,
  sourceNumber: r.adjustment_number ?? r.count_number ?? null,
  sourceId: (r.adjustment_id ?? r.count_id)?.toString() ?? null,
  memo: r.memo,
  totalFils: r.total_debit_fils.toString(),
  postedAt: r.posted_at.toISOString(),
  postedBy: r.posted_by.toString(),
  postedByName: { displayNameAr: r.display_name_ar, displayNameEn: r.display_name_en },
});

export async function listJournal(db: Kysely<DB>, query: JournalQuery): Promise<JournalResponse> {
  let q = entryBase(db);
  if (query.from) q = q.where('e.entry_date', '>=', query.from);
  if (query.to) q = q.where('e.entry_date', '<=', query.to);
  if (query.source) q = q.where('e.source_type', '=', query.source);
  if (query.accountId) {
    const accountId = BigInt(query.accountId);
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom('gl.journal_lines as l')
          .select('l.id')
          .whereRef('l.entry_id', '=', 'e.id')
          .where('l.account_id', '=', accountId),
      ),
    );
  }
  const total = await q
    .clearSelect()
    .select(sql<number>`count(*)::int`.as('n'))
    .executeTakeFirstOrThrow();
  const rows = await q
    .orderBy('e.entry_date', 'desc')
    .orderBy('e.id', 'desc')
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .execute();
  return { total: total.n, entries: rows.map(entryItem) };
}

export async function getJournalEntry(db: Kysely<DB>, id: bigint): Promise<JournalEntryDetail> {
  const row = await entryBase(db).where('e.id', '=', id).executeTakeFirst();
  if (!row) throw new AppError('NOT_FOUND', 'No such journal entry');
  const lines = await db
    .selectFrom('gl.journal_lines as l')
    .innerJoin('gl.accounts as a', 'a.id', 'l.account_id')
    .select([
      'l.line_no',
      'l.account_id',
      'a.code',
      'a.name_ar',
      'a.name_en',
      'l.debit_fils',
      'l.credit_fils',
      'l.customer_id',
      'l.business_line_id',
      'l.memo',
    ])
    .where('l.entry_id', '=', id)
    .orderBy('l.line_no')
    .execute();
  return {
    ...entryItem(row),
    lines: lines.map((l) => ({
      lineNo: l.line_no,
      accountId: l.account_id.toString(),
      accountCode: l.code,
      accountNameAr: l.name_ar,
      accountNameEn: l.name_en,
      debitFils: l.debit_fils.toString(),
      creditFils: l.credit_fils.toString(),
      customerId: l.customer_id?.toString() ?? null,
      businessLineId: l.business_line_id?.toString() ?? null,
      memo: l.memo,
    })),
  };
}

/** Debits, credits and the balance of every account that moved between two dates. */
export async function trialBalance(
  db: Kysely<DB>,
  query: TrialBalanceQuery,
): Promise<TrialBalanceResponse> {
  const rows = await db
    .selectFrom('gl.journal_lines as l')
    .innerJoin('gl.journal_entries as e', 'e.id', 'l.entry_id')
    .innerJoin('gl.accounts as a', 'a.id', 'l.account_id')
    .select([
      'a.id',
      'a.code',
      'a.name_ar',
      'a.name_en',
      'a.account_type',
      sql<string>`sum(l.debit_fils)::text`.as('debit'),
      sql<string>`sum(l.credit_fils)::text`.as('credit'),
    ])
    .where('e.entry_date', '>=', query.from)
    .where('e.entry_date', '<=', query.to)
    .groupBy(['a.id', 'a.code', 'a.name_ar', 'a.name_en', 'a.account_type'])
    .orderBy('a.code')
    .execute();
  let debit = 0n;
  let credit = 0n;
  const out = rows.map((r) => {
    debit += BigInt(r.debit);
    credit += BigInt(r.credit);
    return {
      accountId: r.id.toString(),
      code: r.code,
      nameAr: r.name_ar,
      nameEn: r.name_en,
      accountType: r.account_type,
      debitFils: r.debit,
      creditFils: r.credit,
      balanceFils: (BigInt(r.debit) - BigInt(r.credit)).toString(),
    };
  });
  return { rows: out, totalDebitFils: debit.toString(), totalCreditFils: credit.toString() };
}
