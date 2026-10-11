import { Hourglass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Chip, DefinitionList, Note } from '../../../ui';
import { useCan } from '../../auth/context';
import { useVat } from '../../masterdata/refs';
import { LockedField, LockedList } from '../company/LockedField';
import { CardHead, NoAccess, PanelHeader, Section, settingsClasses } from '../parts';
import { PeriodsCard } from './PeriodsCard';
import { SeriesCard } from './SeriesCard';

/**
 * Settings → VAT & numbering (design 13). Each card is shown only to people with its
 * permission; the server checks again. VAT categories live in Settings → Lists (decision 0034).
 */
export function TaxPanel() {
  const { t } = useTranslation('setup');
  const can = useCan();
  const series = can('system.series.manage');
  const periods = can('ledger.view');
  if (!series && !periods) return <NoAccess />;
  return (
    <>
      <PanelHeader title={t('tax.title')} subtitle={t('tax.subtitle')} />
      <div className={settingsClasses.two}>
        <Section index={1}>
          <CardHead title={t('tax.calc.title')} />
          <LockedList>
            <LockedField label={t('tax.calc.vat')}>{t('tax.calc.vatValue')}</LockedField>
            <LockedField label={t('tax.calc.rounding')}>{t('tax.calc.roundingValue')}</LockedField>
            <LockedField label={t('tax.calc.prices')}>{t('tax.calc.pricesValue')}</LockedField>
          </LockedList>
          <Note className={settingsClasses.tableNote}>{t('tax.calc.categories')}</Note>
        </Section>
        <EinvoicingCard />
      </div>
      {series && <SeriesCard index={3} />}
      {periods && <PeriodsCard index={4} />}
    </>
  );
}

/** E-invoicing through an accredited provider; the date waits for the accountant (0019). */
function EinvoicingCard() {
  const { t } = useTranslation('setup');
  const vat = useVat();
  const from = vat.data?.einvoiceMandatoryFrom ?? null;
  return (
    <Section index={2}>
      <CardHead title={t('tax.einvoice.title')} />
      <DefinitionList
        rows={[
          {
            label: t('tax.einvoice.mandatoryFrom'),
            value: from ? (
              <bdi>{from}</bdi>
            ) : vat.isSuccess ? (
              <Chip tone="warn" icon={<Hourglass aria-hidden="true" />}>
                {t('tax.einvoice.waiting')}
              </Chip>
            ) : (
              '—'
            ),
          },
          { label: t('tax.einvoice.provider'), value: t('tax.einvoice.notSet') },
        ]}
      />
      <Note>{t('tax.einvoice.note')}</Note>
    </Section>
  );
}
