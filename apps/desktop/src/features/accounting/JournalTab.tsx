/**
 * Accounting → Journal: every entry the system posted (JV-…), newest first, filtered by date,
 * source and account; one entry opens with its lines. Entries are never edited here: a mistake
 * is corrected by a reversing entry (decision 0016). Amounts are exact fils from the server.
 */
import { useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  JOURNAL_SOURCES,
  type AccountsResponse,
  type JournalEntryDetail,
  type JournalEntryItem,
  type JournalResponse,
} from '@artepool/shared/contracts';
import { formatDate, formatDateTime } from '../../lib/format';
import {
  Button,
  Card,
  cx,
  DefinitionList,
  Dialog,
  DialogFooter,
  iconClass,
  SelectField,
  tableClasses,
} from '../../ui';
import { useApi } from '../../api/hooks';
import { localName, MD_KEYS } from '../masterdata/refs';
import { money } from '../masterdata/format';
import { SaveError, useAccountLabel } from '../settings/lists/parts';
import { DateRangeFields, isValidRange, thisMonth, type DateRange } from './period';
import styles from './accounting.module.css';

export const JOURNAL_PAGE_SIZE = 50;

/** `JV-…` and a short date: the dialog title and the row's label. */
const dayText = (isoDay: string) => formatDate(`${isoDay}T12:00:00Z`);

export function JournalTab({ data }: { data: AccountsResponse }) {
  const { t } = useTranslation('accounting');
  const api = useApi();
  const label = useAccountLabel();
  const [range, setRange] = useState<DateRange>(() => thisMonth());
  const [source, setSource] = useState('');
  const [accountId, setAccountId] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const valid = isValidRange(range);

  const params = new URLSearchParams({
    from: range.from,
    to: range.to,
    page: String(page),
    pageSize: String(JOURNAL_PAGE_SIZE),
  });
  if (source) params.set('source', source);
  if (accountId) params.set('accountId', accountId);
  const query = params.toString();
  const journal = useQuery({
    queryKey: [...MD_KEYS.journal, 'list', query],
    queryFn: () => api.get<JournalResponse>(`/api/v1/journal?${query}`),
    enabled: valid,
    placeholderData: keepPreviousData,
  });

  const entries = valid ? (journal.data?.entries ?? []) : [];
  const total = valid ? (journal.data?.total ?? 0) : 0;
  const pages = Math.max(1, Math.ceil(total / JOURNAL_PAGE_SIZE));
  // Any change of filter starts again from the first page.
  const filter =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPage(1);
    };

  const onRowKey = (event: KeyboardEvent, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpenId(id);
    }
  };

  return (
    <Card rise index={2} padding="table">
      <div className={styles.filters}>
        <DateRangeFields value={range} onChange={filter(setRange)} />
        <SelectField
          id="journal-source"
          label={t('journal.source')}
          value={source}
          onChange={filter(setSource)}
          options={[
            { value: '', label: t('journal.allSources') },
            ...JOURNAL_SOURCES.map((value) => ({ value, label: t(`sources.${value}`) })),
          ]}
        />
        <SelectField
          id="journal-account"
          label={t('journal.account')}
          value={accountId}
          onChange={filter(setAccountId)}
          options={[
            { value: '', label: t('journal.allAccounts') },
            ...data.accounts
              .filter((a) => a.isPostable)
              .map((a) => ({ value: a.id, label: label(a) })),
          ]}
        />
      </div>
      {journal.isError && <SaveError error={journal.error} />}
      <table
        className={cx(tableClasses.table, tableClasses.selectable)}
        aria-label={t('tabs.journal')}
        aria-busy={journal.isFetching}
      >
        <thead>
          <tr>
            <th>{t('journal.number')}</th>
            <th>{t('journal.date')}</th>
            <th>{t('journal.source')}</th>
            <th className={tableClasses.num}>{t('journal.total')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.id}
              data-testid={`entry-${entry.entryNumber}`}
              tabIndex={0}
              aria-label={t('journal.openOne', { number: entry.entryNumber })}
              onClick={() => setOpenId(entry.id)}
              onKeyDown={(event) => onRowKey(event, entry.id)}
            >
              <td>
                <b>
                  <bdi>{entry.entryNumber}</bdi>
                </b>
                {entry.memo && <span className={tableClasses.sub}>{entry.memo}</span>}
              </td>
              <td>
                <bdi>{dayText(entry.entryDate)}</bdi>
              </td>
              <td>
                <SourceText entry={entry} />
              </td>
              <td className={tableClasses.num}>
                <bdi>{money(BigInt(entry.totalFils))}</bdi>
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr className={tableClasses.empty}>
              <td colSpan={4}>
                {journal.isLoading
                  ? t('loading')
                  : valid
                    ? t('journal.empty')
                    : t('period.invalid')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {total > 0 && (
        <div className={styles.pager}>
          <span className={styles.muted}>
            {t('journal.count', { total: String(total) })} ·{' '}
            {t('journal.page', { page: String(page), pages: String(pages) })}
          </span>
          <span className={styles.pagerButtons}>
            <Button
              variant="ghost"
              isDisabled={page <= 1}
              onPress={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className={cx(iconClass.sm, 'flip-rtl')} aria-hidden="true" />
              {t('journal.previous')}
            </Button>
            <Button
              variant="ghost"
              isDisabled={page >= pages}
              onPress={() => setPage((p) => Math.min(pages, p + 1))}
            >
              {t('journal.next')}
              <ChevronRight className={cx(iconClass.sm, 'flip-rtl')} aria-hidden="true" />
            </Button>
          </span>
        </div>
      )}
      {openId && <EntryDialog id={openId} onClose={() => setOpenId(null)} />}
    </Card>
  );
}

/** "Stock adjustment · ADJ-000004" (the document number only when there is one). */
function SourceText({ entry }: { entry: JournalEntryItem }) {
  const { t } = useTranslation('accounting');
  return (
    <span>
      {t(`sources.${entry.sourceType}`)}
      {entry.sourceNumber && (
        <>
          {' · '}
          <bdi>{entry.sourceNumber}</bdi>
        </>
      )}
    </span>
  );
}

/** One entry with its lines; debit and credit totals are always equal (a database rule). */
function EntryDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, i18n } = useTranslation('accounting');
  const api = useApi();
  const nameOf = localName(i18n.language);
  const entry = useQuery({
    queryKey: [...MD_KEYS.journal, 'entry', id],
    queryFn: () => api.get<JournalEntryDetail>(`/api/v1/journal/${id}`),
  });
  const data = entry.data;
  const debit = data?.lines.reduce((sum, l) => sum + BigInt(l.debitFils), 0n) ?? 0n;
  const credit = data?.lines.reduce((sum, l) => sum + BigInt(l.creditFils), 0n) ?? 0n;

  return (
    <Dialog
      isOpen
      wide
      onClose={onClose}
      title={data ? t('entry.title', { number: data.entryNumber }) : t('entry.loadingTitle')}
    >
      {entry.isError && <SaveError error={entry.error} />}
      {entry.isLoading && <p className={styles.muted}>{t('loading')}</p>}
      {data && (
        <div className={styles.entry}>
          <DefinitionList
            rows={[
              { label: t('journal.date'), value: <bdi>{dayText(data.entryDate)}</bdi> },
              { label: t('journal.source'), value: <SourceText entry={data} /> },
              ...(data.memo ? [{ label: t('entry.memo'), value: data.memo }] : []),
              {
                label: t('entry.posted'),
                value: (
                  <>
                    <bdi>{formatDateTime(data.postedAt)}</bdi>
                    {' · '}
                    {t('entry.postedBy', { user: data.postedBy })}
                  </>
                ),
              },
            ]}
          />
          <div className={styles.scroll}>
            <table className={tableClasses.table} aria-label={t('entry.lines')}>
              <thead>
                <tr>
                  <th>{t('col.code')}</th>
                  <th>{t('col.name')}</th>
                  <th className={tableClasses.num}>{t('entry.debit')}</th>
                  <th className={tableClasses.num}>{t('entry.credit')}</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((line) => (
                  <tr key={line.lineNo} data-testid={`line-${line.lineNo}`}>
                    <td>
                      <bdi>{line.accountCode}</bdi>
                    </td>
                    <td>
                      {nameOf({ nameAr: line.accountNameAr, nameEn: line.accountNameEn })}
                      {line.memo && <span className={tableClasses.sub}>{line.memo}</span>}
                    </td>
                    <td className={tableClasses.num}>
                      {line.debitFils !== '0' && <bdi>{money(BigInt(line.debitFils))}</bdi>}
                    </td>
                    <td className={tableClasses.num}>
                      {line.creditFils !== '0' && <bdi>{money(BigInt(line.creditFils))}</bdi>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className={styles.totals} data-testid="entry-totals">
                  <td colSpan={2}>{t('entry.totals')}</td>
                  <td className={tableClasses.num}>
                    <bdi>{money(debit)}</bdi>
                  </td>
                  <td className={tableClasses.num}>
                    <bdi>{money(credit)}</bdi>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
      <DialogFooter>
        <Button onPress={onClose}>{t('entry.close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
