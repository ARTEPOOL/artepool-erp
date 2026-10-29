/**
 * The customer's account in the Customers detail (design 14): the balance banner and, with
 * customers.balance.view (decision 0114), what they owe, the overdue part, the credit, advance
 * payments and the net position, the open invoices with their age, and the oldest unpaid date;
 * then the statement of account and, for the owner, the opening balance.
 */
import { useState } from 'react';
import { FileSpreadsheet, HandCoins, Landmark } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from '@tanstack/react-router';
import type { CustomerBalance, CustomerDetail } from '@artepool/shared/contracts';
import {
  Button,
  Card,
  CardHeader,
  cx,
  DefinitionList,
  iconClass,
  tableClasses as tbl,
} from '../../ui';
import { formatDate } from '../../lib/format';
import { useCan } from '../auth/context';
import { money } from '../masterdata/format';
import { useCustomerBalance } from '../sales/api';
import { BalanceBanner } from '../sales/CustomerBalanceBanner';
import { OpeningBalanceDialog } from './OpeningBalanceDialog';
import { StatementDialog } from './StatementDialog';
import styles from './receipts.module.css';

export function CustomerAccount({ customer }: { customer: CustomerDetail }) {
  const { t } = useTranslation('receipts');
  const can = useCan();
  const [dialog, setDialog] = useState<'statement' | 'opening' | null>(null);
  const balance = useCustomerBalance(customer.id, { detail: true });
  const b = balance.data;
  const statements = can('statements.view');
  const opening = can('customers.opening');
  const receive = can('payments.receive') && customer.isActive;
  const navigate = useNavigate();

  if (!b && !statements && !opening && !receive) return null;
  return (
    <Card rise index={3}>
      <CardHeader title={t('account.title')} />
      <div className={styles.form}>
        {b && <BalanceBanner balance={b} />}
        {b?.amounts && <Amounts balance={b} amounts={b.amounts} />}
        {b?.openDebts && <OpenDebts balance={b} />}
        {balance.isError && <p className={styles.muted}>{t('account.unavailable')}</p>}
        {(statements || opening || receive) && (
          <div className={styles.accountActions}>
            {receive && (
              <Button
                onPress={() =>
                  void navigate({
                    to: '/receipts/$paymentId',
                    params: { paymentId: 'new' },
                    search: { customerId: customer.id },
                  })
                }
              >
                <HandCoins className={iconClass.sm} aria-hidden="true" />
                {t('receive.button')}
              </Button>
            )}
            {statements && (
              <Button onPress={() => setDialog('statement')}>
                <FileSpreadsheet className={iconClass.sm} aria-hidden="true" />
                {t('statement.button')}
              </Button>
            )}
            {opening && (
              <Button variant="ghost" onPress={() => setDialog('opening')}>
                <Landmark className={iconClass.sm} aria-hidden="true" />
                {t('openingBalance.button')}
              </Button>
            )}
          </div>
        )}
      </div>
      {dialog === 'statement' && (
        <StatementDialog customer={customer} onClose={() => setDialog(null)} />
      )}
      {dialog === 'opening' && (
        <OpeningBalanceDialog customer={customer} onClose={() => setDialog(null)} />
      )}
    </Card>
  );
}

/** Outstanding, overdue, credit, available, advance payments and the net position. */
function Amounts(props: {
  balance: CustomerBalance;
  amounts: NonNullable<CustomerBalance['amounts']>;
}) {
  const { t } = useTranslation('receipts');
  const a = props.amounts;
  const owed = BigInt(a.outstandingFils);
  const net = BigInt(a.netPositionFils);
  const amount = (fils: bigint, owes = false) => (
    <bdi className={owes && fils > 0n ? styles.owes : undefined}>{money(fils)}</bdi>
  );
  return (
    <DefinitionList
      rows={[
        {
          label: owed < 0n ? t('account.weOwe') : t('account.balance'),
          value: amount(owed < 0n ? -owed : owed, true),
        },
        { label: t('account.overdue'), value: amount(BigInt(a.overdueFils), true) },
        {
          label: t('account.credit'),
          value:
            props.balance.creditMode === 'credit'
              ? t('sales:customerPicker.credit', { limit: money(BigInt(a.creditLimitFils)) })
              : t('sales:customerPicker.cash'),
        },
        { label: t('account.available'), value: amount(BigInt(a.availableFils)) },
        { label: t('account.advances'), value: amount(BigInt(a.advancesFils)) },
        {
          label: t('account.netPosition'),
          value: (
            <span>
              {amount(net, true)}
              <span className={cx(styles.muted, styles.netHint)}>{t('account.netHint')}</span>
            </span>
          ),
        },
        ...(props.balance.oldestUnpaidDate
          ? [
              {
                label: t('account.oldestUnpaid'),
                value: <bdi>{formatDate(props.balance.oldestUnpaidDate)}</bdi>,
              },
            ]
          : []),
      ]}
    />
  );
}

/** What is still owed, oldest first: number, date, due date, amount due, age, days overdue. */
function OpenDebts({ balance }: { balance: CustomerBalance }) {
  const { t } = useTranslation('receipts');
  const debts = balance.openDebts ?? [];
  if (debts.length === 0) return <p className={styles.muted}>{t('account.noOpen')}</p>;
  return (
    <table className={tbl.table} aria-label={t('account.openTitle')}>
      <caption className={styles.caption}>{t('account.openTitle')}</caption>
      <thead>
        <tr>
          <th>{t('account.cols.document')}</th>
          <th>{t('account.cols.date')}</th>
          <th>{t('account.cols.due')}</th>
          <th className={tbl.num}>{t('account.cols.amount')}</th>
          <th className={tbl.num}>{t('account.cols.age')}</th>
          <th className={tbl.num}>{t('account.cols.late')}</th>
        </tr>
      </thead>
      <tbody>
        {debts.map((d) => (
          <tr key={`${d.kind}-${d.documentId ?? d.date}`}>
            <td>
              {d.documentId ? (
                <Link
                  to="/invoices/$documentId"
                  params={{ documentId: d.documentId }}
                  className={styles.link}
                >
                  <bdi>{d.docNumber}</bdi>
                </Link>
              ) : (
                <span>
                  {t('account.openingBalance')}
                  {d.docNumber && (
                    <>
                      {' · '}
                      <bdi>{d.docNumber}</bdi>
                    </>
                  )}
                </span>
              )}
            </td>
            <td>
              <bdi>{formatDate(d.date)}</bdi>
            </td>
            <td>{d.dueDate ? <bdi>{formatDate(d.dueDate)}</bdi> : '—'}</td>
            <td className={tbl.num}>
              <bdi>{money(BigInt(d.dueFils))}</bdi>
            </td>
            <td className={tbl.num}>{t('account.days', { count: d.ageDays })}</td>
            <td className={cx(tbl.num, d.daysOverdue > 0 && styles.owes)}>
              {d.daysOverdue > 0 ? t('account.days', { count: d.daysOverdue }) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
