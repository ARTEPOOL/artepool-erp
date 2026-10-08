import { useTranslation } from 'react-i18next';
import { PanelHeader } from '../parts';

/** Settings → Tax (design 13; decision 0034). */
export function TaxPanel() {
  const { t } = useTranslation('settings');
  return <PanelHeader title={t('hub.tax')} />;
}
