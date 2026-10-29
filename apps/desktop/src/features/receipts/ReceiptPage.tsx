/**
 * One receipt: receiving a payment (`new`) or a saved receipt, refund or reversal, with what it
 * settled, the payment invoice it created, printing (A4, print dialog, decision 0008) and the
 * reversal of a bounced cheque (decision 0048).
 */
import { useState } from 'react';
import { ArrowLeft, FileText, Lock, Printer, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type { PaymentDetail } from '@artepool/shared/contracts';
import { useApi } from '../../api/hooks';
import { formatDate } from '../../lib/format';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  cx,
  DefinitionList,
  EmptyState,
  iconClass,
  InfoBar,
  pageClasses,
  PageHeader,
  tableClasses as tbl,
  useToast,
} from '../../ui';
import { useCan, useDisplayName, useErrorText } from '../auth/context';
import { money } from '../masterdata/format';
import { fetchPdf, SALES_PATHS, usePayment } from '../sales/api';
import { printPdf } from '../sales/print';
import { PaymentKindChip, ReversedChip, useKindText, useMethodName } from './parts';
import { useCustomer } from '../customers/api';
import { chosenFrom } from '../sales/CustomerPicker';
import { ReceiveForm } from './ReceiveForm';
import { ReverseDialog } from './ReverseDialog';
import salesStyles from '../sales/sales.module.css';
import styles from './receipts.module.css';

function BackLink() {
  const { t } = useTranslation('receipts');
  return (
    <Link to="/receipts" className={styles.backLink}>
      <ArrowLeft className={cx(iconClass.sm, styles.flip)} aria-hidden="true" />
      {t('back')}
    </Link>
  );
}

function ReceiptView({ payment: p }: { payment: PaymentDetail }) {
  const { t } = useTranslation('receipts');
  const can = useCan();
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const nameOf = useDisplayName();
  const methodName = useMethodName();
  const kindText = useKindText();
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<unknown>(null);
  const [reversing, setReversing] = useState(false);

  const print = async () => {
    setPrinting(true);
    setPrintError(null);
    try {
      await printPdf(await fetchPdf(api, SALES_PATHS.paymentPdf(p.id)));
    } catch (error) {
      setPrintError(error);
    } finally {
      setPrinting(false);
    }
  };

  const advance = p.advanceDocumentId
    ? p.allocations.find((a) => a.documentId === p.advanceDocumentId)
    : undefined;
  const reversible = p.status === 'posted' && p.paymentKind !== 'reversal';
  const none = '—';

  const rows = [
    {
      label: t('detail.kind'),
      value: (
        <span className={styles.chips}>
          <PaymentKindChip kind={p.paymentKind} />
          {p.status === 'reversed' && <ReversedChip />}
        </span>
      ),
    },
    { label: t('sales:fields.date'), value: <bdi>{formatDate(p.paymentDate)}</bdi> },
    { label: t('sales:fields.customer'), value: p.customerName },
    { label: t('sales:fields.method'), value: methodName(p.paymentMethodId, p.methodKind) },
    {
      label: p.chequeDate ? t('receive.chequeNumber') : t('sales:fields.reference'),
      value: p.reference ? <bdi>{p.reference}</bdi> : none,
    },
    ...(p.chequeDate
      ? [{ label: t('receive.chequeDate'), value: <bdi>{formatDate(p.chequeDate)}</bdi> }]
      : []),
    ...(p.chequeBank ? [{ label: t('receive.chequeBank'), value: p.chequeBank }] : []),
    {
      label: t('sales:fields.amount'),
      value: (
        <b className={styles.amount}>
          <bdi>{money(BigInt(p.amountFils))}</bdi>
        </b>
      ),
    },
    ...(p.receivedByName
      ? [{ label: t('detail.receivedBy'), value: nameOf(p.receivedByName) }]
      : []),
    ...(p.notes ? [{ label: t('sales:fields.notes'), value: p.notes }] : []),
    // Decision 0113: why it was kept as an advance while invoices were open.
    ...(p.advanceReason ? [{ label: t('detail.advanceReason'), value: p.advanceReason }] : []),
  ];

  return (
    <>
      <Card rise index={1}>
        <DefinitionList rows={rows} />
      </Card>

      {advance && advance.documentId && (
        <InfoBar icon={<FileText aria-hidden="true" />}>
          <span>
            {t('detail.advanceInvoice')}{' '}
            <Link
              to="/invoices/$documentId"
              params={{ documentId: advance.documentId }}
              className={styles.link}
            >
              <bdi>{advance.docNumber ?? advance.documentId}</bdi>
            </Link>
          </span>
        </InfoBar>
      )}
      {p.reversalOfId && (
        <InfoBar icon={<RotateCcw aria-hidden="true" />}>
          <span>
            {t(p.paymentKind === 'reversal' ? 'detail.reverses' : 'detail.original')}{' '}
            <Link
              to="/receipts/$paymentId"
              params={{ paymentId: p.reversalOfId }}
              className={styles.link}
            >
              {t('detail.openOriginal')}
            </Link>
          </span>
        </InfoBar>
      )}

      <Card rise index={2} padding="table">
        <CardHeader title={t('detail.allocations')} />
        <div className={styles.tableWrap}>
          <table className={tbl.table} aria-label={t('detail.allocations')}>
            <thead>
              <tr>
                <th>{t('detail.document')}</th>
                <th>{t('receive.type')}</th>
                <th className={tbl.num}>{t('sales:fields.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {p.allocations.map((a, index) => (
                <tr key={`${a.documentId ?? a.openingBalanceId ?? ''}-${index}`}>
                  <td className={styles.numberCell}>
                    {a.documentId ? (
                      <Link
                        to="/invoices/$documentId"
                        params={{ documentId: a.documentId }}
                        className={styles.link}
                      >
                        <bdi>{a.docNumber ?? a.documentId}</bdi>
                      </Link>
                    ) : (
                      t('openingBalance.short')
                    )}
                  </td>
                  <td>{kindText(a.docType)}</td>
                  <td className={tbl.num}>
                    <bdi>{money(BigInt(a.amountFils))}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {p.allocations.length === 0 && <EmptyState>{t('detail.noAllocations')}</EmptyState>}
      </Card>

      {printError !== null && <Alert>{errorText(printError)}</Alert>}
      <div className={salesStyles.actions}>
        {can('payments.reverse') && reversible && (
          <Button variant="dangerGhost" onPress={() => setReversing(true)}>
            <RotateCcw className={iconClass.sm} aria-hidden="true" />
            {t('reverse.button')}
          </Button>
        )}
        <Button variant="primary" busy={printing} onPress={() => void print()}>
          <Printer className={iconClass.sm} aria-hidden="true" />
          {t('sales:print.print')}
        </Button>
      </div>

      {reversing && (
        <ReverseDialog
          payment={p}
          onClose={() => setReversing(false)}
          onReversed={(reversal) => {
            setReversing(false);
            toast(t('reverse.done', { number: reversal.docNumber }));
            void navigate({ to: '/receipts/$paymentId', params: { paymentId: reversal.id } });
          }}
        />
      )}
    </>
  );
}

function SavedReceipt({ id }: { id: string }) {
  const { t } = useTranslation('receipts');
  const errorText = useErrorText();
  const payment = usePayment(id);
  const p = payment.data;
  return (
    <div className={pageClasses.page}>
      <PageHeader
        title={p ? <bdi>{p.docNumber}</bdi> : t('title')}
        subtitle={p ? t(`detail.subtitle.${p.paymentKind}`) : undefined}
        tools={<BackLink />}
      />
      {p ? (
        <ReceiptView payment={p} />
      ) : payment.isError ? (
        <Alert>{errorText(payment.error)}</Alert>
      ) : (
        <EmptyState>{t('sales:loading')}</EmptyState>
      )}
    </div>
  );
}

export function ReceiptPage() {
  const { t } = useTranslation('receipts');
  const can = useCan();
  const { paymentId } = useParams({ from: '/receipts/$paymentId' });
  const isNew = paymentId === 'new';
  if (!can('invoices.view') || (isNew && !can('payments.receive'))) {
    return (
      <div className={pageClasses.page}>
        <PageHeader title={t('title')} tools={<BackLink />} />
        <InfoBar icon={<Lock aria-hidden="true" />}>{t('sales:noAccess')}</InfoBar>
      </div>
    );
  }
  return isNew ? <NewReceipt /> : <SavedReceipt key={paymentId} id={paymentId} />;
}

/** A new receipt, with the customer already chosen when the link names one. */
function NewReceipt() {
  const { t } = useTranslation('receipts');
  const { customerId, documentId } = useSearch({ from: '/receipts/$paymentId' });
  const customer = useCustomer(customerId ?? null);
  if (customerId && customer.isPending) {
    return (
      <div className={pageClasses.page}>
        <PageHeader title={t('title')} tools={<BackLink />} />
        <p>{t('sales:loading')}</p>
      </div>
    );
  }
  return (
    <ReceiveForm
      initialCustomer={customer.data && customer.data.isActive ? chosenFrom(customer.data) : null}
      initialDocumentId={documentId ?? null}
    />
  );
}
