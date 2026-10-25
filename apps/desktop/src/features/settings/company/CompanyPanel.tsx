import { useTranslation } from 'react-i18next';
import { Alert, Card } from '../../../ui';
import { useCan, useErrorText } from '../../auth/context';
import { useCompany } from '../../masterdata/refs';
import { CardHead, NoAccess, PanelHeader, Section, settingsClasses } from '../parts';
import { BankAccountsCard } from './BankAccountsCard';
import { LegalDetailsCard } from './LegalDetailsCard';
import { LockedField, LockedList } from './LockedField';
import { LogoCard } from './LogoCard';

/** Fixed for the whole system: dirhams, and Al Ain time from the server (golden rule 8). */
const CURRENCY = 'AED';
const TIME_ZONE = 'Asia/Dubai';

/**
 * Settings → Company (design 13): the details printed on every tax invoice. Owner only
 * (decision 0030, `system.company.edit`); the server checks again on every save.
 */
export function CompanyPanel() {
  const { t } = useTranslation('setup');
  const can = useCan();
  const errorText = useErrorText();
  const query = useCompany();
  if (!can('system.company.edit')) return <NoAccess />;
  const company = query.data?.company ?? null;
  const canEdit = query.data?.canEdit ?? false;
  return (
    <>
      <PanelHeader title={t('company.title')} subtitle={t('company.subtitle')} />
      {query.isError && <Alert>{errorText(query.error)}</Alert>}
      {query.isPending && (
        <Card rise index={1}>
          <p className={settingsClasses.helpText}>{t('loading')}</p>
        </Card>
      )}
      {query.data && (
        <>
          <LegalDetailsCard company={company} canEdit={canEdit} />
          <div className={settingsClasses.two}>
            <LogoCard company={company} canEdit={canEdit} />
            <Section index={3}>
              <CardHead title={t('company.general.title')} />
              <LockedList>
                <LockedField label={t('company.general.currency')}>
                  <bdi>{company?.currency ?? CURRENCY}</bdi> · {t('company.general.currencyName')}
                </LockedField>
                <LockedField label={t('company.general.timeZone')}>
                  <bdi>{TIME_ZONE}</bdi> · {t('company.general.serverTime')}
                </LockedField>
                <LockedField label={t('company.general.fiscalYear')}>
                  {t('company.general.fiscalYearValue')}
                </LockedField>
              </LockedList>
            </Section>
          </div>
          <BankAccountsCard index={4} />
        </>
      )}
    </>
  );
}
