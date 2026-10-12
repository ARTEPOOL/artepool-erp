import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState, InfoBar, PageHeader, Tabs } from '../../ui';
import { useCan } from '../auth/context';
import { useAccounts } from '../masterdata/refs';
import { SaveError } from '../settings/lists/parts';
import { ChartTab } from './ChartTab';
import { JournalTab } from './JournalTab';
import { LinksTab } from './LinksTab';
import { TrialBalanceTab } from './TrialBalanceTab';
import styles from './accounting.module.css';

type TabId = 'chart' | 'links' | 'journal' | 'trial';

/**
 * Accounting: chart of accounts, event links, the journal and the trial balance (decisions 0016,
 * 0018, 0034, 0035). The whole page needs `ledger.view`; the server checks it on every call.
 */
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
            { value: 'journal', label: t('tabs.journal') },
            { value: 'trial', label: t('tabs.trial') },
          ]}
        />
        {tab === 'trial' ? (
          <TrialBalanceTab />
        ) : (
          <>
            {accounts.isError && <SaveError error={accounts.error} />}
            {accounts.isLoading && <EmptyState>{t('loading')}</EmptyState>}
            {accounts.data && tab === 'chart' && <ChartTab data={accounts.data} />}
            {accounts.data && tab === 'links' && <LinksTab data={accounts.data} />}
            {accounts.data && tab === 'journal' && <JournalTab data={accounts.data} />}
          </>
        )}
      </div>
    </>
  );
}
