/**
 * The customer's balance under the chosen customer (decision 0114), on the A4 invoice, the POS
 * and the receipt: green nothing due, yellow within the limit, orange overdue or 80% of the limit,
 * red over the limit (an unpaid sale then needs a supervisor's approval, 0046). Everyone sees the
 * colour and the words; the amounts come only to customers.balance.view (the server sends none
 * otherwise). Advance payments have their own line and never reduce what is owed.
 */
import { AlertTriangle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { showsBalanceBanner, type BalanceStatus } from '@artepool/shared';
import type { CustomerBalance, CustomerListItem } from '@artepool/shared/contracts';
import { cx, iconClass } from '../../ui';
import { money } from '../masterdata/format';
import { useCustomerBalance } from './api';
import styles from './balance.module.css';

const TONE: Record<BalanceStatus, 'green' | 'yellow' | 'orange' | 'red'> = {
  nothing_due: 'green',
  within_limit: 'yellow',
  near_limit: 'orange',
  overdue: 'orange',
  over_limit: 'red',
};

const ICON = {
  nothing_due: CheckCircle2,
  within_limit: Info,
  near_limit: AlertTriangle,
  overdue: AlertTriangle,
  over_limit: TriangleAlert,
} as const;

/** The words for a status; a cash customer who owes is told apart from a credit one over the limit. */
export function balanceWords(b: Pick<CustomerBalance, 'status' | 'creditMode'>): string {
  return b.status === 'over_limit' && b.creditMode === 'cash' ? 'cash_owes' : b.status;
}

export function BalanceBanner(props: { balance: CustomerBalance; compact?: boolean }) {
  const { t } = useTranslation('sales');
  const b = props.balance;
  if (!showsBalanceBanner(b)) return null;
  const a = b.amounts;
  const Icon = ICON[b.status];
  const advances = a ? BigInt(a.advancesFils) : 0n;
  return (
    <div
      className={cx(styles.banner, styles[TONE[b.status]], props.compact && styles.compact)}
      role="status"
      aria-label={t('balance.label')}
      data-status={b.status}
    >
      <Icon className={iconClass.sm} aria-hidden="true" />
      <div className={styles.body}>
        <b>{t(`balance.status.${balanceWords(b)}`)}</b>
        {a && (
          <span className={styles.figures}>
            <span>{t('balance.outstanding', { amount: money(BigInt(a.outstandingFils)) })}</span>
            {BigInt(a.overdueFils) > 0n && (
              <span>{t('balance.overdue', { amount: money(BigInt(a.overdueFils)) })}</span>
            )}
            <span>{t('balance.limit', { amount: money(BigInt(a.creditLimitFils)) })}</span>
            <span>{t('balance.available', { amount: money(BigInt(a.availableFils)) })}</span>
          </span>
        )}
        {advances > 0n && (
          <span className={styles.figures}>
            <span>{t('balance.advances', { amount: money(advances) })}</span>
          </span>
        )}
      </div>
    </div>
  );
}

/** The banner for a chosen customer; nothing for the walk-in customer or while it loads. */
export function CustomerBalanceBanner(props: {
  customerId: string | null;
  isWalkIn?: boolean;
  compact?: boolean;
}) {
  const balance = useCustomerBalance(props.isWalkIn ? null : props.customerId);
  if (!balance.data) return null;
  return <BalanceBanner balance={balance.data} compact={props.compact ?? false} />;
}

/**
 * The customers list's Outstanding cell: the amount with its colour (customers.balance.view), or
 * the colour and the words; empty for a customer who owes nothing.
 */
export function BalanceCell(props: {
  balance: NonNullable<CustomerListItem['balance']>;
  creditMode: CustomerListItem['creditMode'];
}) {
  const { t } = useTranslation('sales');
  const b = props.balance;
  if (b.status === 'nothing_due' && (b.outstandingFils === null || b.outstandingFils === '0'))
    return <span className={styles.none}>—</span>;
  return (
    <span className={cx(styles.cell, styles[TONE[b.status]])} data-status={b.status}>
      {b.outstandingFils !== null ? (
        <bdi>{money(BigInt(b.outstandingFils))}</bdi>
      ) : (
        t(`balance.status.${balanceWords({ status: b.status, creditMode: props.creditMode })}`)
      )}
    </span>
  );
}
