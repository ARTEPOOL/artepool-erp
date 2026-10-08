import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui';

/** Design 14: Customers (balance parts arrive in M4). */
export function CustomersPage() {
  const { t } = useTranslation('parties');
  return <PageHeader title={t('customers.title')} subtitle={t('customers.subtitle')} />;
}
