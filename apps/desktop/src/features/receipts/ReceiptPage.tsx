/**
 * One receipt: receiving a payment (`new`) or a saved receipt.
 */
import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useParams } from '@tanstack/react-router';
import { InfoBar, pageClasses, PageHeader } from '../../ui';
import { useCan } from '../auth/context';

export function ReceiptPage() {
  const { t } = useTranslation('receipts');
  const can = useCan();
  const { paymentId } = useParams({ from: '/receipts/$paymentId' });
  return (
    <div className={pageClasses.page}>
      <PageHeader title={t('title')} subtitle={paymentId} />
      {!can('invoices.view') && (
        <InfoBar icon={<Lock aria-hidden="true" />}>{t('sales:noAccess')}</InfoBar>
      )}
    </div>
  );
}
