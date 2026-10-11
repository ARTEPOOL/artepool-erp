/**
 * Journal entries for stock documents (posting map rows 12–15 and 21). The inventory side is
 * built from the movements' own book amounts per stock status, so the inventory accounts always
 * equal the books of the stock ledger, to the fils (decision 0014). The other side depends on why
 * the stock moved.
 */
import type { LinkKey, PostingAmount } from './posting';

export type StockDocumentKind =
  'opening' | 'increase' | 'decrease' | 'status_change' | 'write_off' | 'oversell' | 'count';

const STATUS_ACCOUNT: Record<string, LinkKey> = {
  available: 'inventory',
  defective: 'inventory_defective',
};

const OTHER_SIDE: Record<StockDocumentKind, LinkKey> = {
  opening: 'opening_balance_equity', // row 21
  increase: 'stock_adjustments', // row 13 (more found)
  decrease: 'stock_adjustments', // row 13 (less found)
  count: 'stock_adjustments', // row 13
  oversell: 'stock_adjustments', // row 12
  status_change: 'stock_adjustments', // row 14: only a 1-fils rounding difference, if any
  write_off: 'write_off', // row 15
};

/** The amounts of a stock document's entry, from its movements (status, signed book fils). */
export function stockPosting(
  kind: StockDocumentKind,
  movements: readonly { stockStatus: string; valueFils: bigint }[],
): PostingAmount[] {
  const byAccount = new Map<LinkKey, bigint>();
  for (const m of movements) {
    const link = STATUS_ACCOUNT[m.stockStatus];
    if (!link) throw new Error(`Unknown stock status ${m.stockStatus}`);
    byAccount.set(link, (byAccount.get(link) ?? 0n) + m.valueFils);
  }
  const amounts: PostingAmount[] = [...byAccount].map(([link, fils]) => ({ link, fils }));
  const total = amounts.reduce((sum, a) => sum + a.fils, 0n);
  amounts.push({ link: OTHER_SIDE[kind], fils: -total });
  return amounts;
}
