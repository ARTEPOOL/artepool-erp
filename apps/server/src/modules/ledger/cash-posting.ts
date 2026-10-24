/**
 * The journal entries of the cash drawer (docs/accounting/posting-map.md rows 16–19). Pure
 * functions: signed amounts (positive = debit) that postEntry writes. The drawers account is the
 * POS cash payment method's account and a paid-in / paid-out reason names its own account — data,
 * never a hard-coded code (decision 0018).
 */
import type { PostingAmount } from './posting';

export type DrawerMovementType =
  'opening_float' | 'paid_in' | 'paid_out' | 'cash_drop' | 'float_top_up' | 'closing_transfer';

/** Rows 16–18: money into or out of the drawer, against the safe or the reason's account. */
export function movementPosting(m: {
  type: DrawerMovementType;
  amountFils: bigint;
  drawerAccountId: bigint;
  reasonAccountId?: bigint | null;
}): PostingAmount[] {
  const drawer = { accountId: m.drawerAccountId };
  const into = ['opening_float', 'paid_in', 'float_top_up'].includes(m.type);
  const other: PostingAmount['link'] =
    m.type === 'paid_in' || m.type === 'paid_out'
      ? { accountId: m.reasonAccountId! }
      : 'cash_in_safe';
  if ((m.type === 'paid_in' || m.type === 'paid_out') && !m.reasonAccountId) {
    throw new Error('A paid-in or paid-out needs the account of its reason');
  }
  const sign = into ? 1n : -1n;
  return [
    { link: drawer, fils: sign * m.amountFils },
    { link: other, fils: -sign * m.amountFils },
  ];
}

/** Row 19: the accepted over/short (counted − expected) between the drawers and Cash over/short. */
export function variancePosting(varianceFils: bigint, drawerAccountId: bigint): PostingAmount[] {
  return [
    { link: { accountId: drawerAccountId }, fils: varianceFils },
    { link: 'cash_over_short', fils: -varianceFils },
  ];
}
