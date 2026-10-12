/**
 * Accounting → Trial balance: the debits, credits and balance of every account that received
 * postings in a date range (headers are not listed: they never receive postings). The two
 * totals are always equal; the "Balanced" mark says so. Amounts are exact fils.
 */
import { useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { TrialBalanceResponse } from '@artepool/shared/contracts';
import { Card, Chip, tableClasses } from '../../ui';
import { useApi } from '../../api/hooks';
import { localName, MD_KEYS } from '../masterdata/refs';
import { money } from '../masterdata/format';
import { SaveError } from '../settings/lists/parts';
import { DateRangeFields, isValidRange, thisMonth, type DateRange } from './period';
import styles from './accounting.module.css';

/** Debit − credit as "1,234.50 Dr" / "1,234.50 Cr" (zero has no side). */
function BalanceText({ fils }: { fils: bigint }) {
  const { t } = useTranslation('accounting');
  if (fils === 0n) return <bdi>{money(0n)}</bdi>;
  const side = fils > 0n ? t('trial.dr') : t('trial.cr');
  return (
    <>
      <bdi>{money(fils > 0n ? fils : -fils)}</bdi> {side}
    </>
  );
}

export function TrialBalanceTab() {
  const { t, i18n } = useTranslation('accounting');
  const api = useApi();
  const nameOf = localName(i18n.language);
  const [range, setRange] = useState<DateRange>(() => thisMonth());
  const valid = isValidRange(range);
  const query = new URLSearchParams({ from: range.from, to: range.to }).toString();
  const trial = useQuery({
    queryKey: [...MD_KEYS.journal, 'trial-balance', query],
    queryFn: () => api.get<TrialBalanceResponse>(`/api/v1/trial-balance?${query}`),
    enabled: valid,
    placeholderData: keepPreviousData,
  });

  const data = valid ? trial.data : undefined;
  const rows = data?.rows ?? [];
  const debit = BigInt(data?.totalDebitFils ?? '0');
  const credit = BigInt(data?.totalCreditFils ?? '0');

  return (
    <Card rise index={2} padding="table">
      <div className={styles.filters}>
        <DateRangeFields value={range} onChange={setRange} />
      </div>
      {trial.isError && <SaveError error={trial.error} />}
      <table
        className={tableClasses.table}
        aria-label={t('tabs.trial')}
        aria-busy={trial.isFetching}
      >
        <thead>
          <tr>
            <th>{t('col.code')}</th>
            <th>{t('col.name')}</th>
            <th className={tableClasses.num}>{t('entry.debit')}</th>
            <th className={tableClasses.num}>{t('entry.credit')}</th>
            <th className={tableClasses.num}>{t('trial.balance')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.accountId} data-testid={`trial-${row.code}`}>
              <td>
                <b>
                  <bdi>{row.code}</bdi>
                </b>
              </td>
              <td>
                {nameOf(row)}
                <span className={tableClasses.sub}>
                  {i18n.exists(`accounting:types.${row.accountType}`)
                    ? t(`types.${row.accountType}`)
                    : row.accountType}
                </span>
              </td>
              <td className={tableClasses.num}>
                <bdi>{money(BigInt(row.debitFils))}</bdi>
              </td>
              <td className={tableClasses.num}>
                <bdi>{money(BigInt(row.creditFils))}</bdi>
              </td>
              <td className={tableClasses.num}>
                <BalanceText fils={BigInt(row.balanceFils)} />
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr className={tableClasses.empty}>
              <td colSpan={5}>
                {trial.isLoading ? t('loading') : valid ? t('trial.empty') : t('period.invalid')}
              </td>
            </tr>
          )}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className={styles.totals} data-testid="trial-totals">
              <td colSpan={2}>
                <span className={styles.totalsLabel}>
                  {t('trial.totals')}
                  {debit === credit ? (
                    <Chip tone="ok" icon={<CheckCircle2 aria-hidden="true" />}>
                      {t('trial.balanced')}
                    </Chip>
                  ) : (
                    <Chip tone="danger" icon={<AlertTriangle aria-hidden="true" />}>
                      {t('trial.unbalanced')}
                    </Chip>
                  )}
                </span>
              </td>
              <td className={tableClasses.num}>
                <bdi>{money(debit)}</bdi>
              </td>
              <td className={tableClasses.num}>
                <bdi>{money(credit)}</bdi>
              </td>
              <td className={tableClasses.num}>
                <BalanceText fils={debit - credit} />
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </Card>
  );
}
