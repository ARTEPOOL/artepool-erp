/**
 * Invoices (A4): tabs for invoices (with advance payment invoices), credit notes and debit notes
 * (decisions 0045, 0113); receipts have their own section. Filters by status and payment
 * (overdue too), and a search by number or customer. Each invoice shows one worked-out status.
 * A row opens the document; "New invoice" opens an empty draft.
 */
import { useState } from 'react';
import { FileText, Lock, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import type { DocumentItem, DocumentsQuery } from '@artepool/shared/contracts';
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
  Segmented,
  SelectField,
  tableClasses as tbl,
  ToolBar,
} from '../../ui';
import { formatDate } from '../../lib/format';
import { useCan, useErrorText } from '../auth/context';
import { money } from '../masterdata/format';
import { useDocuments } from '../sales/api';
import { InvoiceStateChips, useDebounced } from './parts';
import styles from './invoices.module.css';

// "Issued" lists the issued documents still standing; "cancelled" the issued invoices a credit
// note for all of it cancelled or replaced (0072); "discarded" the drafts thrown away.
const STATUSES = ['draft', 'active', 'cancelled', 'discarded'] as const;
const SETTLEMENTS = ['open', 'partial', 'settled', 'unpaid', 'overdue'] as const;
const GROUPS = ['invoices', 'credit_notes', 'debit_notes'] as const;

type Group = (typeof GROUPS)[number];
type StatusFilter = '' | (typeof STATUSES)[number];
type SettlementFilter = '' | (typeof SETTLEMENTS)[number];

/** Money shown in a table cell. */
const Amount = ({ fils }: { fils: bigint }) => <bdi>{money(fils)}</bdi>;

export function InvoicesPage() {
  const { t } = useTranslation('invoices');
  const can = useCan();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const allowed = can('invoices.view');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [group, setGroup] = useState<Group>('invoices');
  const [status, setStatus] = useState<StatusFilter>('');
  const [settlement, setSettlement] = useState<SettlementFilter>('');

  const query: Partial<DocumentsQuery> = {
    ...(q ? { q } : {}),
    group,
    ...(status ? { status } : {}),
    ...(settlement ? { settlement } : {}),
  };
  const documents = useDocuments(query, allowed);
  const list: DocumentItem[] = documents.data?.documents ?? [];

  const open = (id: string) =>
    void navigate({ to: '/invoices/$documentId', params: { documentId: id } });

  const tools = allowed && can('invoices.create') && (
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
          <Segmented<Group>
            label={t('list.tabsLabel')}
            value={group}
            onChange={setGroup}
            options={GROUPS.map((g) => ({ value: g, label: t(`list.tabs.${g}`) }))}
          />
          <ToolBar index={1}>
            <SearchField label={t('list.search')} value={search} onChange={setSearch} />
            <div className={styles.filters}>
              <SelectField
                id="invoices-status"
                label={t('sales:fields.status')}
                value={status}
                onChange={(v) => setStatus(v as StatusFilter)}
                options={[
                  { value: '', label: t('list.allStatuses') },
                  ...STATUSES.map((v) => ({ value: v, label: t(`list.statuses.${v}`) })),
                ]}
              />
              <SelectField
                id="invoices-settlement"
                label={t('list.settlement')}
                value={settlement}
                onChange={(v) => setSettlement(v as SettlementFilter)}
                options={[
                  { value: '', label: t('list.allSettlements') },
                  ...SETTLEMENTS.map((v) => ({
                    value: v,
                    label:
                      v === 'unpaid'
                        ? t('list.notFullyPaid')
                        : v === 'overdue'
                          ? t('state.overdue')
                          : t(`sales:settlement.${v}`),
                  })),
                ]}
              />
            </div>
          </ToolBar>
          <Card rise index={2} padding="table">
            <table
              className={cx(tbl.table, tbl.selectable)}
              aria-label={t('list.label')}
              aria-busy={documents.isFetching}
            >
              <thead>
                <tr>
                  <th>{t('sales:fields.number')}</th>
                  <th>{t('sales:fields.customer')}</th>
                  <th>{t('sales:fields.issueDate')}</th>
                  <th className={tbl.num}>{t('sales:fields.total')}</th>
                  <th className={tbl.num}>{t('list.paidDue')}</th>
                  <th>{t('sales:fields.status')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((d) => {
                  const total = BigInt(d.totalFils);
                  const paid = BigInt(d.settledFils);
                  return (
                    <tr
                      key={d.id}
                      tabIndex={0}
                      onClick={() => open(d.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          open(d.id);
                        }
                      }}
                    >
                      <td>
                        {d.docNumber ? (
                          <bdi className={styles.numberCell}>{d.docNumber}</bdi>
                        ) : (
                          <span className={tbl.sub}>{t('list.draftNumber')}</span>
                        )}
                        <span className={tbl.sub}>
                          {t(`sales:docTypes.${d.docType}`)}
                          {d.originalDocumentNumber && (
                            <>
                              {' · '}
                              <bdi>
                                {t('list.forDocument', { number: d.originalDocumentNumber })}
                              </bdi>
                            </>
                          )}
                        </span>
                      </td>
                      <td>{d.customerName}</td>
                      <td>{d.issueDate ? <bdi>{formatDate(d.issueDate)}</bdi> : '—'}</td>
                      <td className={tbl.num}>
                        <Amount fils={total} />
                      </td>
                      <td className={tbl.num}>
                        {d.status === 'issued' ? (
                          <>
                            <Amount fils={paid} />
                            <span className={tbl.sub}>
                              {t('list.due', { amount: money(total - paid) })}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <div className={styles.chips}>
                          <InvoiceStateChips doc={d} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {documents.isLoading && (
                  <tr className={tbl.empty}>
                    <td colSpan={6}>{t('sales:loading')}</td>
                  </tr>
                )}
              </tbody>
            </table>
            {documents.isError && <Alert>{errorText(documents.error)}</Alert>}
            {documents.isSuccess && list.length === 0 && (
              <EmptyState>
                <FileText className={styles.emptyIcon} aria-hidden="true" />
                {t('list.empty')}
              </EmptyState>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
