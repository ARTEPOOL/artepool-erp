/**
 * One invoice: a draft being written (`new`) or a saved document.
 */
import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useParams } from '@tanstack/react-router';
import { InfoBar, pageClasses, PageHeader } from '../../ui';
import { useCan } from '../auth/context';

export function InvoicePage() {
  const { t } = useTranslation('invoices');
  const can = useCan();
  const { documentId } = useParams({ from: '/invoices/$documentId' });
  return (
    <div className={pageClasses.page}>
      <PageHeader title={t('title')} subtitle={documentId} />
      {!can('invoices.view') && (
        <InfoBar icon={<Lock aria-hidden="true" />}>{t('sales:noAccess')}</InfoBar>
      )}
    </div>
  );
}
