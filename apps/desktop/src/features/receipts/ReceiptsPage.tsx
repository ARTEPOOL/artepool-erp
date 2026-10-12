/**
 * Receipts: money received from customers, refunds and reversals (decisions 0045, 0052).
 * The list with its filters; a row opens the receipt, "Receive payment" opens a new one.
 */
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Lock, Plus, ReceiptText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import type { PaymentItem, PaymentsQuery } from '@artepool/shared/contracts';
import { formatDate } from '../../lib/format';
import {
  Alert,
  Button,
  Card,
  cx,
  EmptyState,
  iconClass,
  InfoBar,
  pageClasses,
  PageHeader,
  SearchField,
  Segmented,
  SelectField,
  tableClasses as tbl,
  ToolBar,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { money } from '../masterdata/format';
import { usePayments } from '../sales/api';
import { PaymentKindChip, ReversedChip, useMethodName } from './parts';
import styles from './receipts.module.css';

type KindFilter = 'all' | NonNullable<PaymentsQuery['kind']>;
const KINDS: KindFilter[] = ['all', 'receipt', 'refund', 'reversal'];
const METHOD_KINDS = ['cash', 'card', 'bank_transfer', 'cheque', 'other'] as const;

function useDebounced(value: string, ms = 250) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setShown(value.trim()), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

export function ReceiptsPage() {
  const { t } = useTranslation('receipts');
  const can = useCan();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const methodName = useMethodName();
  const allowed = can('invoices.view');
  const [kind, setKind] = useState<KindFilter>('all');
  const [method, setMethod] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const payments = usePayments(
    { kind: kind === 'all' ? undefined : kind, q: q || undefined },
    allowed,
  );
  const all: PaymentItem[] = payments.data?.payments ?? [];
  // The server filters by kind and search; the method is filtered on the rows shown.
  const list = method ? all.filter((p) => p.methodKind === method) : all;

  const open = (id: string) =>
    void navigate({ to: '/receipts/$paymentId', params: { paymentId: id } });
  const onRowKey = (event: KeyboardEvent, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open(id);
    }
  };

  const tools = allowed && can('payments.receive') && (
    <Button variant="primary" onPress={() => open('new')}>
      <Plus className={iconClass.sm} aria-hidden="true" />
      {t('receive.button')}
    </Button>
  );

  return (
    <div className={pageClasses.page}>
      <PageHeader title={t('title')} subtitle={t('subtitle')} tools={tools} />
      {!allowed ? (
        <InfoBar icon={<Lock aria-hidden="true" />}>{t('sales:noAccess')}</InfoBar>
      ) : (
        <>
          <ToolBar index={1}>
            <SearchField label={t('list.search')} value={search} onChange={setSearch} />
            <div className={styles.filters}>
              <Segmented<KindFilter>
                label={t('list.kind')}
                value={kind}
                onChange={setKind}
                options={KINDS.map((value) => ({
                  value,
                  label: value === 'all' ? t('list.all') : t(`sales:paymentKinds.${value}`),
                }))}
              />
              <SelectField
                id="receipts-method"
                label={t('list.method')}
                value={method}
                onChange={setMethod}
                options={[
                  { value: '', label: t('list.allMethods') },
                  ...METHOD_KINDS.map((value) => ({
                    value,
                    label: t(`sales:methodKinds.${value}`),
                  })),
                ]}
              />
            </div>
          </ToolBar>
          <Card rise index={2} padding="table">
            <div className={styles.tableWrap}>
              <table
                className={cx(tbl.table, tbl.selectable)}
                aria-label={t('list.label')}
                aria-busy={payments.isFetching}
              >
                <thead>
                  <tr>
                    <th>{t('sales:fields.number')}</th>
                    <th>{t('list.kindCol')}</th>
                    <th>{t('sales:fields.customer')}</th>
                    <th>{t('sales:fields.date')}</th>
                    <th>{t('sales:fields.method')}</th>
                    <th className={tbl.num}>{t('sales:fields.amount')}</th>
                    <th>{t('sales:fields.reference')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr
                      key={p.id}
                      tabIndex={0}
                      className={cx(p.status === 'reversed' && tbl.off)}
                      onClick={() => open(p.id)}
                      onKeyDown={(event) => onRowKey(event, p.id)}
                    >
                      <td className={styles.numberCell}>
                        <bdi>{p.docNumber}</bdi>
                      </td>
                      <td>
                        <span className={styles.chips}>
                          <PaymentKindChip kind={p.paymentKind} />
                          {p.status === 'reversed' && <ReversedChip />}
                        </span>
                      </td>
                      <td>{p.customerName}</td>
                      <td>
                        <bdi>{formatDate(p.paymentDate)}</bdi>
                      </td>
                      <td>{methodName(p.paymentMethodId, p.methodKind)}</td>
                      <td className={tbl.num}>
                        <bdi>{money(BigInt(p.amountFils))}</bdi>
                      </td>
                      <td>{p.reference ? <bdi>{p.reference}</bdi> : '—'}</td>
                    </tr>
                  ))}
                  {payments.isLoading && (
                    <tr className={tbl.empty}>
                      <td colSpan={7}>{t('sales:loading')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {payments.isError && <Alert>{errorText(payments.error)}</Alert>}
            {payments.isSuccess && list.length === 0 && (
              <EmptyState>
                <ReceiptText className={styles.emptyIcon} aria-hidden="true" />
                {t('list.empty')}
              </EmptyState>
            )}
            {payments.isSuccess && payments.data.total > all.length && (
              <p className={styles.muted}>
                {t('list.shown', { shown: all.length, total: payments.data.total })}
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
