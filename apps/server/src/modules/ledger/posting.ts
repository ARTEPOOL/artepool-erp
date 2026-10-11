/**
 * The table-driven posting engine (decision 0018). Every financial event writes one journal entry
 * in the same transaction as the event (golden rule 4). Accounts are named by their event link
 * (gl.account_mappings), never by a hard-coded code, so the accountant can change them; the
 * database refuses an entry that does not balance, a document posted twice, or a closed month.
 */
import type { Transaction } from 'kysely';
import type { DB } from '../../platform/db/schema.generated';
import { filledByDatabase, stamped } from '../../platform/db/stamped';
import { AppError } from '../../platform/errors/app-error';

/** The event links the engine knows (docs/accounting/posting-map.md). */
export type LinkKey =
  | 'ar_control'
  | 'ap_control'
  | 'customer_advances'
  | 'vat_output'
  | 'vat_input'
  | 'inventory'
  | 'inventory_defective'
  | 'stock_adjustments'
  | 'write_off'
  | 'cash_over_short'
  | 'cash_in_safe'
  | 'opening_balance_equity';

/** One side of the entry: a signed amount (positive = debit, negative = credit). */
export interface PostingAmount {
  link: LinkKey;
  fils: bigint;
  customerId?: bigint;
  businessLineId?: bigint;
  vatCategoryId?: bigint;
  memo?: string;
}

export type PostingSource =
  { type: 'inventory_adjustment'; id: bigint } | { type: 'inventory_count'; id: bigint };

export interface PostedEntry {
  id: bigint;
  entryNumber: string;
}

const SOURCE_COLUMN = {
  inventory_adjustment: 'inventory_adjustment_id',
  inventory_count: 'inventory_count_id',
} as const;

/**
 * Posts one entry. Amounts on the same link and dimensions are added together, zero amounts are
 * dropped, and an event worth nothing posts nothing (returns null). The amounts must add up to
 * zero: an unbalanced call is a programming error and is refused before the database sees it.
 */
export async function postEntry(
  trx: Transaction<DB>,
  entry: { date: string; source: PostingSource; memo?: string; amounts: PostingAmount[] },
): Promise<PostedEntry | null> {
  const merged = new Map<string, PostingAmount>();
  for (const a of entry.amounts) {
    const key = [a.link, a.customerId, a.businessLineId, a.vatCategoryId].join('|');
    const current = merged.get(key);
    merged.set(key, current ? { ...current, fils: current.fils + a.fils } : { ...a });
  }
  const lines = [...merged.values()].filter((a) => a.fils !== 0n);
  const total = lines.reduce((sum, a) => sum + a.fils, 0n);
  if (total !== 0n) {
    throw new AppError('INTERNAL', `Posting does not balance by ${total} fils`);
  }
  if (lines.length === 0) return null;

  const links = await trx
    .selectFrom('gl.account_mappings')
    .select(['key', 'account_id'])
    .where('key', 'in', [...new Set(lines.map((l) => l.link))])
    .execute();
  const accountOf = new Map(links.map((l) => [l.key, l.account_id]));
  const debit = lines.reduce((sum, a) => (a.fils > 0n ? sum + a.fils : sum), 0n);

  const header = await trx
    .insertInto('gl.journal_entries')
    .values(
      filledByDatabase('gl.journal_entries', {
        entry_date: entry.date,
        source_type: entry.source.type,
        [SOURCE_COLUMN[entry.source.type]]: entry.source.id,
        memo: entry.memo ?? null,
        total_debit_fils: debit,
        total_credit_fils: debit,
      }),
    )
    .returning(['id', 'entry_number'])
    .executeTakeFirstOrThrow();

  await trx
    .insertInto('gl.journal_lines')
    .values(
      lines.map((a, i) => {
        const accountId = accountOf.get(a.link);
        if (accountId === undefined)
          throw new AppError('INTERNAL', `Event link ${a.link} is missing`);
        return stamped('gl.journal_lines', {
          entry_id: header.id,
          line_no: i + 1,
          account_id: accountId,
          debit_fils: a.fils > 0n ? a.fils : 0n,
          credit_fils: a.fils < 0n ? -a.fils : 0n,
          customer_id: a.customerId ?? null,
          business_line_id: a.businessLineId ?? null,
          vat_category_id: a.vatCategoryId ?? null,
          memo: a.memo ?? null,
        });
      }),
    )
    .execute();
  return { id: header.id, entryNumber: header.entry_number };
}
