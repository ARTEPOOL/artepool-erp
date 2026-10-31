/**
 * The customer's balance status (decision 0114), judged the same way by the server, the banner
 * and the tests. From the amounts in fils: nothing due (green), within the limit (yellow), near
 * the limit at 80% or more (orange), overdue invoices (orange), over the limit (red; an unpaid
 * sale then needs a supervisor's approval, 0046, which uses the same "outstanding > limit").
 * Advance payments never change it: they are not subtracted from what is owed and do not add to
 * the credit (conservative).
 */

export const BALANCE_STATUSES = [
  'nothing_due',
  'within_limit',
  'near_limit',
  'overdue',
  'over_limit',
] as const;
export type BalanceStatus = (typeof BALANCE_STATUSES)[number];

export interface BalanceFigures {
  outstandingFils: bigint;
  overdueFils: bigint;
  /** 0 for a cash customer. */
  creditLimitFils: bigint;
}

export function balanceStatus(f: BalanceFigures): BalanceStatus {
  if (f.outstandingFils <= 0n) return 'nothing_due';
  if (f.outstandingFils > f.creditLimitFils) return 'over_limit';
  if (f.overdueFils > 0n) return 'overdue';
  if (f.outstandingFils * 10n >= f.creditLimitFils * 8n) return 'near_limit';
  return 'within_limit';
}

/**
 * Whether the banner shows (decision 0114): never for the walk-in customer; for a cash customer
 * only when they owe something (it is then red, their limit being 0); always for a credit customer.
 */
export function showsBalanceBanner(c: {
  isWalkIn: boolean;
  creditMode: 'cash' | 'credit';
  status: BalanceStatus;
}): boolean {
  if (c.isWalkIn) return false;
  return c.creditMode === 'credit' || c.status !== 'nothing_due';
}
