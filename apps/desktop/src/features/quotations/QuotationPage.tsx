/**
 * One quotation: a new one (`new`) or a saved one with its revisions.
 */
import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useParams } from '@tanstack/react-router';
import { InfoBar, pageClasses, PageHeader } from '../../ui';
import { useCan } from '../auth/context';

export function QuotationPage() {
  const { t } = useTranslation('quotations');
  const can = useCan();
  const { quotationId } = useParams({ from: '/quotations/$quotationId' });
  return (
    <div className={pageClasses.page}>
      <PageHeader title={t('title')} subtitle={quotationId} />
      {!can('quotations.manage') && (
        <InfoBar icon={<Lock aria-hidden="true" />}>{t('sales:noAccess')}</InfoBar>
      )}
    </div>
  );
}
