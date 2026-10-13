import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { BadgeCheck, Ban, Download, Plus, Store, Upload, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { CustomerDetail, FilePayload } from '@artepool/shared/contracts';
import { useApi } from '../../api/hooks';
import {
  Alert,
  Button,
  Card,
  Chip,
  cx,
  EmptyState,
  iconClass,
  Kpi,
  Kpis,
  Note,
  PageHeader,
  pageClasses,
  SearchField,
  Segmented,
  SplitView,
  tableClasses as tbl,
  Tile,
  ToolBar,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { downloadFile } from '../masterdata/files';
import { ImportDialog } from '../masterdata/ImportDialog';
import { MD_KEYS } from '../masterdata/refs';
import { CustomerAccount } from '../receipts/CustomerAccount';
import { CUSTOMER_FILTERS, useCustomer, useCustomerList, type CustomerFilter } from './api';
import { CreditChip, CustomerCard } from './CustomerCard';
import { CUSTOMER_TYPE_ICONS, CustomerDialog } from './CustomerDialog';
import { partiesClasses as styles, Phone, useDebounced, VatChip } from './parts';

/**
 * Design 14: Customers. Since M4 the detail also shows the account (balance, statement of
 * account, opening balance; features/receipts). Overdue and aging come later.
 */
export function CustomersPage() {
  const { t } = useTranslation(['parties', 'masterdata']);
  const can = useCan();
  const api = useApi();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [filter, setFilter] = useState<CustomerFilter>('active');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);

  const list = useCustomerList(q, filter);
  const customers = useMemo(
    () => list.data?.pages.flatMap((page) => page.customers) ?? [],
    [list.data],
  );
  const first = list.data?.pages[0];
  const detail = useCustomer(selectedId);

  // A new search or filter starts again from its first customer.
  useEffect(() => setSelectedId(null), [q, filter]);
  useEffect(() => {
    if (selectedId === null && customers.length > 0 && !list.isPlaceholderData) {
      setSelectedId((customers.find((c) => !c.isWalkIn) ?? customers[0])!.id);
    }
  }, [customers, selectedId, list.isPlaceholderData]);

  const reload = async (): Promise<CustomerDetail | null> => {
    if (!selectedId) return null;
    // Read the record itself: a failed read must not bring back the old cached version.
    const fresh = await api.get<CustomerDetail>(`/api/v1/customers/${selectedId}`);
    queryClient.setQueryData(MD_KEYS.customer(selectedId), fresh);
    void queryClient.invalidateQueries({ queryKey: MD_KEYS.customers });
    return fresh;
  };

  const exportAll = async () => {
    setExporting(true);
    setExportError(null);
    try {
      downloadFile(await api.get<FilePayload>('/api/v1/customers/export'));
    } catch (error) {
      setExportError(error);
    } finally {
      setExporting(false);
    }
  };

  const onRowKey = (event: KeyboardEvent, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelectedId(id);
    }
  };

  const tools = (
    <>
      {can('data.import') && can('customers.manage') && (
        <Button onPress={() => setDialog('import')}>
          <Upload className={iconClass.sm} aria-hidden="true" />
          {t('masterdata:actions.import')}
        </Button>
      )}
      {can('data.export') && (
        <Button busy={exporting} onPress={() => void exportAll()}>
          <Download className={iconClass.sm} aria-hidden="true" />
          {t('masterdata:actions.export')}
        </Button>
      )}
      {can('customers.manage') && (
        <Button variant="primary" onPress={() => setDialog('new')}>
          <Plus className={iconClass.sm} aria-hidden="true" />
          {t('parties:customers.new')}
        </Button>
      )}
    </>
  );

  const table = (
    <>
      <ToolBar index={3}>
        <SearchField label={t('parties:customers.search')} value={search} onChange={setSearch} />
        <Segmented<CustomerFilter>
          label={t('parties:customers.filter')}
          value={filter}
          options={CUSTOMER_FILTERS.map((value) => ({
            value,
            label: t(`parties:customers.filters.${value}`),
          }))}
          onChange={setFilter}
        />
      </ToolBar>
      <Card rise index={4} padding="table">
        <table
          className={cx(tbl.table, tbl.selectable)}
          aria-label={t('parties:customers.title')}
          aria-busy={list.isFetching}
        >
          <thead>
            <tr>
              <th>{t('parties:customers.cols.customer')}</th>
              <th>{t('parties:customers.cols.type')}</th>
              <th>{t('parties:customers.cols.vat')}</th>
              <th>{t('parties:customers.cols.payment')}</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr
                key={c.id}
                tabIndex={0}
                aria-selected={c.id === selectedId}
                className={cx(c.id === selectedId && tbl.sel, !c.isActive && tbl.off)}
                onClick={() => setSelectedId(c.id)}
                onKeyDown={(event) => onRowKey(event, c.id)}
              >
                <td>
                  <div className={tbl.who}>
                    <Tile>
                      {c.isWalkIn ? (
                        <Store aria-hidden="true" />
                      ) : (
                        CUSTOMER_TYPE_ICONS[c.customerType]
                      )}
                    </Tile>
                    <span>
                      <b>{c.name}</b>
                      <span className={tbl.sub}>
                        {c.isWalkIn ? (
                          t('parties:customers.walkInShort')
                        ) : (
                          <Phone value={c.phone} />
                        )}
                      </span>
                    </span>
                  </div>
                </td>
                <td className={styles.typeCell}>
                  {c.isWalkIn ? t('parties:types.walkIn') : t(`parties:types.${c.customerType}`)}
                </td>
                <td>
                  <VatChip trn={c.isVatRegistered ? c.trn : null} />
                </td>
                <td>
                  <CreditChip mode={c.creditMode} />
                  {!c.isActive && (
                    <Chip icon={<Ban aria-hidden="true" />}>{t('masterdata:status.inactive')}</Chip>
                  )}
                </td>
              </tr>
            ))}
            {list.isLoading && (
              <tr className={tbl.empty}>
                <td colSpan={4}>{t('parties:loading')}</td>
              </tr>
            )}
          </tbody>
        </table>
        {list.isError && <Alert>{errorText(list.error)}</Alert>}
        {!list.isLoading && !list.isError && customers.length === 0 && (
          <EmptyState>{t('parties:customers.empty')}</EmptyState>
        )}
        {list.hasNextPage && (
          <div className={styles.more}>
            <Button
              variant="ghost"
              busy={list.isFetchingNextPage}
              onPress={() => void list.fetchNextPage()}
            >
              {t('parties:showMore', { shown: customers.length, total: first?.total ?? 0 })}
            </Button>
          </div>
        )}
        <Note className={styles.tableNote}>{t('parties:customers.neverDeleted')}</Note>
      </Card>
    </>
  );

  return (
    <div className={pageClasses.page}>
      <PageHeader
        title={t('parties:customers.title')}
        subtitle={t('parties:customers.subtitle')}
        tools={tools}
      />
      {exportError !== null && <Alert>{errorText(exportError)}</Alert>}
      <Kpis>
        <Kpi
          index={1}
          icon={<Users aria-hidden="true" />}
          label={t('parties:customers.kpis.active')}
          value={<bdi>{first?.counts.active ?? '—'}</bdi>}
        />
        <Kpi
          index={2}
          tone="info"
          icon={<BadgeCheck aria-hidden="true" />}
          label={t('parties:customers.kpis.vat')}
          value={<bdi>{first?.counts.vatRegistered ?? '—'}</bdi>}
        />
      </Kpis>
      <SplitView
        list={table}
        detail={
          detail.data && detail.data.id === selectedId ? (
            <>
              <CustomerCard key={detail.data.id} customer={detail.data} onReload={reload} />
              {!detail.data.isWalkIn && (
                <CustomerAccount key={`account-${detail.data.id}`} customer={detail.data} />
              )}
            </>
          ) : detail.isError ? (
            <Alert>{errorText(detail.error)}</Alert>
          ) : (
            <Card rise index={2}>
              <Note>{selectedId ? t('parties:loading') : t('parties:customers.select')}</Note>
            </Card>
          )
        }
      />
      {dialog === 'new' && (
        <CustomerDialog
          customer={null}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            setSelectedId(saved.id);
          }}
        />
      )}
      {dialog === 'import' && (
        <ImportDialog
          entity="customers"
          title={t('parties:customers.importTitle')}
          intro={t('parties:customers.importIntro')}
          invalidate={[MD_KEYS.customers]}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
