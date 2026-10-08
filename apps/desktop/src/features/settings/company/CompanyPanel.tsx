import { useTranslation } from 'react-i18next';
import { PanelHeader } from '../parts';

/** Settings → Company (design 13; decision 0034). */
export function CompanyPanel() {
  const { t } = useTranslation('settings');
  return <PanelHeader title={t('hub.company')} />;
}
