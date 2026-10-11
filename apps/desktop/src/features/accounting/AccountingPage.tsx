import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState, InfoBar, PageHeader, Tabs } from '../../ui';
import { useCan } from '../auth/context';
import { useAccounts } from '../masterdata/refs';
import { SaveError } from '../settings/lists/parts';
import { ChartTab } from './ChartTab';
import { LinksTab } from './LinksTab';
import styles from './accounting.module.css';

type TabId = 'chart' | 'links';

/** Accounting: chart of accounts and event links (decisions 0018, 0034, 0035). */
export function AccountingPage() {
  const { t } = useTranslation('accounting');
  const can = useCan();
  const accounts = useAccounts();
  const [tab, setTab] = useState<TabId>('chart');

  if (!can('ledger.view')) {
    return (
      <>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <EmptyState>{t('settings:noAccess.body')}</EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className={styles.stack}>
        <InfoBar icon={<AlertTriangle aria-hidden="true" className={styles.warnIcon} />}>
          {t('provisional')}
        </InfoBar>
        <Tabs
          label={t('title')}
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'chart', label: t('tabs.chart') },
            { value: 'links', label: t('tabs.links') },
          ]}
        />
        {accounts.isError && <SaveError error={accounts.error} />}
        {accounts.isLoading && <EmptyState>{t('loading')}</EmptyState>}
        {accounts.data &&
          (tab === 'chart' ? <ChartTab data={accounts.data} /> : <LinksTab data={accounts.data} />)}
      </div>
    </>
  );
}
