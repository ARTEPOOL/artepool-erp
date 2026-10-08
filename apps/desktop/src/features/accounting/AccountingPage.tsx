import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui';

/** Accounting: chart of accounts and event links (decisions 0018, 0034, 0035). */
export function AccountingPage() {
  const { t } = useTranslation('accounting');
  return <PageHeader title={t('title')} subtitle={t('subtitle')} />;
}
