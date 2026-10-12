/** Small pieces shared by the Receipts pages and the customer's account panel. */
import { ArrowDownLeft, ArrowUpRight, Ban, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PaymentItem, SalesPaymentMethod } from '@artepool/shared/contracts';
import { Chip } from '../../ui';
import { localName } from '../masterdata/refs';
import { useSalesPaymentMethods } from '../sales/api';

/** Receipt, refund or reversal: text + icon + colour. */
export function PaymentKindChip({ kind }: { kind: PaymentItem['paymentKind'] }) {
  const { t } = useTranslation('sales');
  if (kind === 'receipt') {
    return (
      <Chip tone="ok" icon={<ArrowDownLeft aria-hidden="true" />}>
        {t('paymentKinds.receipt')}
      </Chip>
    );
  }
  if (kind === 'refund') {
    return (
      <Chip tone="warn" icon={<ArrowUpRight aria-hidden="true" />}>
        {t('paymentKinds.refund')}
      </Chip>
    );
  }
  return (
    <Chip tone="danger" icon={<RotateCcw aria-hidden="true" />}>
      {t('paymentKinds.reversal')}
    </Chip>
  );
}

/** A payment that a reversal (RVS-) has undone. */
export function ReversedChip() {
  const { t } = useTranslation('receipts');
  return <Chip icon={<Ban aria-hidden="true" />}>{t('status.reversed')}</Chip>;
}

/** The payment method's name in the screen's language, or its kind when the list is not loaded. */
export function useMethodName() {
  const { t, i18n } = useTranslation('sales');
  const methods = useSalesPaymentMethods();
  const name = localName(i18n.language);
  return (methodId: string, kind: string) => {
    const method: SalesPaymentMethod | undefined = methods.data?.find((m) => m.id === methodId);
    if (method) return name(method);
    return i18n.exists(`sales:methodKinds.${kind}`) ? t(`methodKinds.${kind}`) : kind;
  };
}

/** What a document or statement line is: tax invoice, receipt, opening balance… */
export function useKindText() {
  const { t } = useTranslation('receipts');
  return (kind: string) => {
    if (kind === 'opening_balance') return t('openingBalance.short');
    if (kind === 'receipt' || kind === 'refund' || kind === 'reversal')
      return t(`sales:paymentKinds.${kind}`);
    return t(`sales:docTypes.${kind}`);
  };
}
