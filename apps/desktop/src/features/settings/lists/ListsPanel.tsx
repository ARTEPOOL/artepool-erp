import { useTranslation } from 'react-i18next';
import { PanelHeader } from '../parts';

/** Settings → Lists (design 13; decision 0034). */
export function ListsPanel() {
  const { t } = useTranslation('settings');
  return <PanelHeader title={t('hub.lists')} />;
}
