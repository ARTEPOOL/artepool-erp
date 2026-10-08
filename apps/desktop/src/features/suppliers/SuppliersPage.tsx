import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui';

/** Suppliers, in the style of design 14 (decision 0034). */
export function SuppliersPage() {
  const { t } = useTranslation('parties');
  return <PageHeader title={t('suppliers.title')} subtitle={t('suppliers.subtitle')} />;
}
