/**
 * Quotations: their own section (decision 0045), valid 15 days by default (0049).
 */
import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { InfoBar, pageClasses, PageHeader } from '../../ui';
import { useCan } from '../auth/context';

export function QuotationsPage() {
  const { t } = useTranslation('quotations');
  const can = useCan();
  return (
    <div className={pageClasses.page}>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {!can('quotations.manage') && (
        <InfoBar icon={<Lock aria-hidden="true" />}>{t('sales:noAccess')}</InfoBar>
      )}
    </div>
  );
}
