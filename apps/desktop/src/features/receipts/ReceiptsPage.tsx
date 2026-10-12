/**
 * Receipts: money received from customers, refunds and reversals (decisions 0045, 0052).
 */
import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { InfoBar, pageClasses, PageHeader } from '../../ui';
import { useCan } from '../auth/context';

export function ReceiptsPage() {
  const { t } = useTranslation('receipts');
  const can = useCan();
  return (
    <div className={pageClasses.page}>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {!can('invoices.view') && (
        <InfoBar icon={<Lock aria-hidden="true" />}>{t('sales:noAccess')}</InfoBar>
      )}
    </div>
  );
}
