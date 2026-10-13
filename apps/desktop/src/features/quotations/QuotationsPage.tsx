/**
 * Quotations: their own section (decision 0045), valid 15 days by default (0049). The list
 * shows each quotation's latest revision with its status; a sent quotation whose validity has
 * run out (or is about to) is marked. Opening a row goes to the quotation's page.
 */
import { useEffect, useState } from 'react';
import { FileText, Lock, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { QUOTATION_STATUSES, type QuotationStatus } from '@artepool/shared/contracts';
import { dubaiDay, formatDate } from '../../lib/format';
import {
  Alert,
  Button,
  Card,
  cx,
  EmptyState,
  iconClass,
  InfoBar,
  pageClasses,
  PageHeader,
  SearchField,
  SelectField,
  tableClasses as tbl,
  ToolBar,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { money } from '../masterdata/format';
import { useQuotations } from '../sales/api';
import { QuotationStatusChip, quotationNumber, validityOf, ValidityChip } from './parts';
import styles from './quotations.module.css';

type StatusFilter = QuotationStatus | 'all';

export function QuotationsPage() {
  const { t } = useTranslation('quotations');
  const can = useCan();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const allowed = can('quotations.manage');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const list = useQuotations(
    { ...(status !== 'all' ? { status } : {}), ...(q ? { q } : {}) },
    allowed,
  );
  const rows = list.data?.quotations ?? [];
  const today = dubaiDay();

  const open = (id: string) =>
    void navigate({ to: '/quotations/$quotationId', params: { quotationId: id } });

  const tools = allowed && (
    <Button variant="primary" onPress={() => open('new')}>
      <Plus className={iconClass.sm} aria-hidden="true" />
      {t('list.new')}
    </Button>
  );

  return (
    <div className={pageClasses.page}>
      <PageHeader title={t('title')} subtitle={t('subtitle')} tools={tools} />
      {!allowed ? (
        <InfoBar icon={<Lock aria-hidden="true" />}>{t('sales:noAccess')}</InfoBar>
      ) : (
        <>
          <ToolBar index={1}>
            <SearchField label={t('list.search')} value={search} onChange={setSearch} />
            <SelectField
              id="quotation-status"
              label={t('list.status')}
              value={status}
              onChange={(value) => setStatus(value as StatusFilter)}
              options={[
                { value: 'all', label: t('list.allStatuses') },
                ...QUOTATION_STATUSES.map((s) => ({
                  value: s,
                  label: t(`sales:quotationStatuses.${s}`),
                })),
              ]}
            />
          </ToolBar>
          <Card rise index={2} padding="table">
            <table
              className={cx(tbl.table, tbl.selectable)}
              aria-label={t('list.label')}
              aria-busy={list.isFetching}
            >
              <thead>
                <tr>
                  <th>{t('sales:fields.number')}</th>
                  <th>{t('list.customerSubject')}</th>
                  <th>{t('sales:fields.date')}</th>
                  <th>{t('fields.validUntil')}</th>
                  <th className={tbl.num}>{t('sales:fields.total')}</th>
                  <th>{t('sales:fields.status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    onClick={() => open(row.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        open(row.id);
                      }
                    }}
                  >
                    <td className={styles.numberCell}>
                      <bdi>{quotationNumber(row)}</bdi>
                    </td>
                    <td>
                      <span>{row.customerName}</span>
                      {row.subject && <span className={tbl.sub}>{row.subject}</span>}
                    </td>
                    <td>
                      <bdi>{formatDate(row.quotationDate)}</bdi>
                    </td>
                    <td>
                      <div className={styles.validCell}>
                        <bdi>{formatDate(row.validUntil)}</bdi>
                        <ValidityChip validity={validityOf(row, today)} />
                      </div>
                    </td>
                    <td className={tbl.num}>
                      <bdi>{money(BigInt(row.totalFils))}</bdi>
                    </td>
                    <td>
                      <QuotationStatusChip status={row.status} />
                    </td>
                  </tr>
                ))}
                {list.isLoading && (
                  <tr className={tbl.empty}>
                    <td colSpan={6}>{t('sales:loading')}</td>
                  </tr>
                )}
              </tbody>
            </table>
            {list.isError && <Alert>{errorText(list.error)}</Alert>}
            {list.isSuccess && rows.length === 0 && (
              <EmptyState>
                <FileText className={styles.emptyIcon} aria-hidden="true" />
                {q || status !== 'all' ? t('list.noMatch') : t('list.empty')}
              </EmptyState>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
