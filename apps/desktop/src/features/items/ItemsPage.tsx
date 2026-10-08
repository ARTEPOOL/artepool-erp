import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui';

/** Design 07: Items & stock (stock parts arrive in M3). */
export function ItemsPage() {
  const { t } = useTranslation('items');
  return <PageHeader title={t('title')} subtitle={t('subtitle')} />;
}
