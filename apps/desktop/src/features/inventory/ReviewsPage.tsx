import { useTranslation } from 'react-i18next';
import { PageHeader, pageClasses } from '../../ui';

/** Placeholder: built in M3-T9. */
export function ReviewsPage() {
  const { t } = useTranslation('inventory');
  return (
    <div className={pageClasses.page}>
      <PageHeader title={t('reviews.title')} />
    </div>
  );
}
