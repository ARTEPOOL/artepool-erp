/**
 * Invoices (A4): the list of tax invoices, payment invoices and notes (decision 0045).
 */
import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { InfoBar, pageClasses, PageHeader } from '../../ui';
import { useCan } from '../auth/context';

export function InvoicesPage() {
  const { t } = useTranslation('invoices');
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
