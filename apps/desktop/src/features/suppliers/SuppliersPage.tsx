import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Ban, Plus, Truck, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { SupplierDetail } from '@artepool/shared/contracts';
import {
  Alert,
  Button,
  Card,
  Chip,
  cx,
  EmptyState,
  iconClass,
  InfoBar,
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
import { partiesClasses as styles, Phone, useDebounced, useTermsText } from '../customers/parts';
import { ImportDialog } from '../masterdata/ImportDialog';
import { MD_KEYS } from '../masterdata/refs';
import { useSupplier, useSupplierList, type SupplierFilter } from './api';
import { SupplierCard } from './SupplierCard';
import { SupplierDialog } from './SupplierDialog';

/** Suppliers, in the style of design 14 (decision 0034). Purchasing arrives in Phase 2. */
export function SuppliersPage() {
  const { t } = useTranslation(['parties', 'masterdata']);
  const termsText = useTermsText();
  const can = useCan();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [filter, setFilter] = useState<SupplierFilter>('active');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'new' | 'import' | null>(null);

  const list = useSupplierList(q, filter);
  const suppliers = useMemo(
    () => list.data?.pages.flatMap((page) => page.suppliers) ?? [],
    [list.data],
  );
  const total = list.data?.pages[0]?.total ?? 0;
  const detail = useSupplier(selectedId);

  useEffect(() => setSelectedId(null), [q, filter]);
  useEffect(() => {
    if (selectedId === null && suppliers.length > 0 && !list.isPlaceholderData) {
      setSelectedId(suppliers[0]!.id);
    }
  }, [suppliers, selectedId, list.isPlaceholderData]);

  const reload = async (): Promise<SupplierDetail | null> => {
    if (!selectedId) return null;
    await queryClient.invalidateQueries({ queryKey: MD_KEYS.suppliers });
    return queryClient.getQueryData<SupplierDetail>(MD_KEYS.supplier(selectedId)) ?? null;
  };

  const onRowKey = (event: KeyboardEvent, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelectedId(id);
    }
  };

  const manage = can('suppliers.manage');
  const tools = manage && (
    <>
      {can('data.import') && (
        <Button onPress={() => setDialog('import')}>
          <Upload className={iconClass.sm} aria-hidden="true" />
          {t('masterdata:actions.import')}
        </Button>
      )}
      <Button variant="primary" onPress={() => setDialog('new')}>
        <Plus className={iconClass.sm} aria-hidden="true" />
        {t('parties:suppliers.new')}
      </Button>
    </>
  );

  const table = (
    <>
      <ToolBar index={2}>
        <SearchField label={t('parties:suppliers.search')} value={search} onChange={setSearch} />
        <Segmented<SupplierFilter>
          label={t('parties:suppliers.filter')}
          value={filter}
          options={(['active', 'inactive'] as const).map((value) => ({
            value,
            label: t(`parties:suppliers.filters.${value}`),
          }))}
          onChange={setFilter}
        />
      </ToolBar>
      <Card rise index={3} padding="table">
        <table
          className={cx(tbl.table, tbl.selectable)}
          aria-label={t('parties:suppliers.title')}
          aria-busy={list.isFetching}
        >
          <thead>
            <tr>
              <th>{t('parties:suppliers.cols.supplier')}</th>
              <th>{t('parties:suppliers.cols.vat')}</th>
              <th>{t('parties:suppliers.cols.terms')}</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((s) => (
              <tr
                key={s.id}
                tabIndex={0}
                aria-selected={s.id === selectedId}
                className={cx(s.id === selectedId && tbl.sel, !s.isActive && tbl.off)}
                onClick={() => setSelectedId(s.id)}
                onKeyDown={(event) => onRowKey(event, s.id)}
              >
                <td>
                  <div className={tbl.who}>
                    <Tile>
                      <Truck aria-hidden="true" />
                    </Tile>
                    <span>
                      <b>{s.name}</b>
                      <span className={tbl.sub}>
                        <Phone value={s.phone} />
                      </span>
                    </span>
                  </div>
                </td>
                <td>
                  {s.isVatRegistered && s.trn ? (
                    <>
                      {t('parties:vat.registered')}
                      <span className={tbl.sub}>
                        <bdi>{t('parties:vat.trn', { trn: s.trn })}</bdi>
                      </span>
                    </>
                  ) : (
                    <span className={tbl.sub}>{t('parties:vat.notRegistered')}</span>
                  )}
                </td>
                <td>
                  <span>{termsText(s.paymentTermsDays)}</span>
                  <span className={tbl.sub}>
                    <bdi>{s.code}</bdi>
                  </span>
                  {!s.isActive && (
                    <Chip icon={<Ban aria-hidden="true" />}>{t('masterdata:status.inactive')}</Chip>
                  )}
                </td>
              </tr>
            ))}
            {list.isLoading && (
              <tr className={tbl.empty}>
                <td colSpan={3}>{t('parties:loading')}</td>
              </tr>
            )}
          </tbody>
        </table>
        {list.isError && <Alert>{errorText(list.error)}</Alert>}
        {!list.isLoading && !list.isError && suppliers.length === 0 && (
          <EmptyState>{t('parties:suppliers.empty')}</EmptyState>
        )}
        {list.hasNextPage && (
          <div className={styles.more}>
            <Button
              variant="ghost"
              busy={list.isFetchingNextPage}
              onPress={() => void list.fetchNextPage()}
            >
              {t('parties:showMore', { shown: suppliers.length, total })}
            </Button>
          </div>
        )}
        <Note className={styles.tableNote}>{t('parties:suppliers.neverDeleted')}</Note>
      </Card>
    </>
  );

  return (
    <div className={pageClasses.page}>
      <PageHeader
        title={t('parties:suppliers.title')}
        subtitle={t('parties:suppliers.subtitle')}
        tools={tools}
      />
      <InfoBar>{t('parties:suppliers.phase2')}</InfoBar>
      <SplitView
        list={table}
        detail={
          detail.data && detail.data.id === selectedId ? (
            <SupplierCard key={detail.data.id} supplier={detail.data} onReload={reload} />
          ) : detail.isError ? (
            <Alert>{errorText(detail.error)}</Alert>
          ) : (
            <Card rise index={2}>
              <Note>{selectedId ? t('parties:loading') : t('parties:suppliers.select')}</Note>
            </Card>
          )
        }
      />
      {dialog === 'new' && (
        <SupplierDialog
          supplier={null}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            setSelectedId(saved.id);
          }}
        />
      )}
      {dialog === 'import' && (
        <ImportDialog
          entity="suppliers"
          title={t('parties:suppliers.importTitle')}
          intro={t('parties:suppliers.importIntro')}
          invalidate={[MD_KEYS.suppliers]}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
