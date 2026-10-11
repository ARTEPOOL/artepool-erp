import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Boxes, FileSpreadsheet, Layers, Package, Plus, Search, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ItemDetail, ItemListItem } from '@artepool/shared/contracts';
import {
  Alert,
  Button,
  Card,
  cx,
  EmptyState,
  iconClass,
  Kpi,
  Kpis,
  pageClasses,
  PageHeader,
  Segmented,
  SplitView,
  tableClasses as tbl,
  ToolBar,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { ImportDialog } from '../masterdata/ImportDialog';
import { localName, MD_KEYS, useCategories, useVat } from '../masterdata/refs';
import { money, priceBoth } from '../masterdata/format';
import { useItemList, type ItemsFilter } from './api';
import { ItemCard } from './ItemCard';
import { ItemDialog } from './ItemDialog';
import { ItemIcon, StatusChip, TypeLabel } from './parts';
import styles from './items.module.css';

type Dialog =
  | { kind: 'new' }
  | { kind: 'edit'; item: ItemDetail }
  | { kind: 'import'; entity: 'items' | 'item_prices' };

const ALL = 'all';
const INACTIVE = 'inactive';

/** Waits until the person stops typing before searching (about a quarter of a second). */
function useDebounced(value: string, ms = 250): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** The list's price cell: with VAT in bold, without VAT under it (decision 0032). */
function PriceCell({ item, rateBp }: { item: ItemListItem; rateBp: number | undefined }) {
  const { t } = useTranslation('items');
  if (!item.price) return <span className={tbl.sub}>{t('list.noPrice')}</span>;
  if (rateBp === undefined) return null;
  const both = priceBoth(BigInt(item.price.price4dp), item.price.includesVat, rateBp);
  return (
    <>
      <b>
        <bdi>{money(both.grossFils)}</bdi>
      </b>
      <span className={tbl.sub}>
        {t('list.exclVat')} <bdi>{money(both.netFils)}</bdi>
      </span>
    </>
  );
}

/** Design 07: Items & stock. The stock parts (value, on hand, cost, movements) arrive in M3. */
export function ItemsPage() {
  const { t, i18n } = useTranslation('items');
  const can = useCan();
  const errorText = useErrorText();
  const name = localName(i18n.language);
  const categories = useCategories();
  const vat = useVat();
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [segment, setSegment] = useState<string>(ALL);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const filter: ItemsFilter = {
    q,
    status: segment === INACTIVE ? 'inactive' : 'active',
    categoryId: segment !== ALL && segment !== INACTIVE ? segment : null,
  };
  const list = useItemList(filter);
  const pages = list.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const total = pages[0]?.total ?? 0;
  const counts = pages[0]?.counts;

  const rates = useMemo(
    () => new Map((vat.data?.categories ?? []).map((c) => [c.id, c.rateBp])),
    [vat.data],
  );
  const topCategories = (categories.data ?? [])
    .filter((c) => c.parentId === null && c.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // F2 puts the cursor in the search field, as in the design.
  const noDialog = dialog === null;
  useEffect(() => {
    if (!noDialog) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'F2') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [noDialog]);

  // The first item is shown until the person chooses another.
  const firstId = items[0]?.id ?? null;
  useEffect(() => {
    if (selectedId === null && firstId !== null) setSelectedId(firstId);
  }, [selectedId, firstId]);

  // A new search starts on its own first result (once the search has actually run).
  useEffect(() => setSelectedId(null), [q]);
  const changeSegment = (value: string) => {
    setSegment(value);
    setSelectedId(null);
  };

  const onRowKey = (event: KeyboardEvent<HTMLTableRowElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelectedId(id);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next =
        event.key === 'ArrowDown'
          ? event.currentTarget.nextElementSibling
          : event.currentTarget.previousElementSibling;
      if (next instanceof HTMLElement && next.tabIndex === 0) next.focus();
    }
  };

  const canImport = can('data.import');
  const tools = (
    <>
      {canImport && can('items.manage') && can('prices.manage') && (
        <Button onPress={() => setDialog({ kind: 'import', entity: 'items' })}>
          <FileSpreadsheet className={iconClass.sm} aria-hidden="true" />
          {t('import.items')}
        </Button>
      )}
      {canImport && can('prices.manage') && (
        <Button onPress={() => setDialog({ kind: 'import', entity: 'item_prices' })}>
          <FileSpreadsheet className={iconClass.sm} aria-hidden="true" />
          {t('import.prices')}
        </Button>
      )}
      {can('items.manage') && (
        <Button variant="primary" onPress={() => setDialog({ kind: 'new' })}>
          <Plus className={iconClass.sm} aria-hidden="true" />
          {t('newItem')}
        </Button>
      )}
    </>
  );

  const shown = items.length;
  const listPart = (
    <>
      <ToolBar index={5}>
        <label className={tbl.search}>
          <Search aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            aria-label={t('search')}
            placeholder={t('search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <kbd className={styles.kbd}>{t('searchKey')}</kbd>
        </label>
        <Segmented
          label={t('filters.label')}
          value={segment}
          onChange={changeSegment}
          options={[
            { value: ALL, label: t('filters.all') },
            ...topCategories.map((c) => ({ value: c.id, label: name(c) })),
            { value: INACTIVE, label: t('filters.inactive') },
          ]}
        />
      </ToolBar>
      <Card rise index={6} padding="table">
        <table
          className={cx(tbl.table, tbl.selectable)}
          aria-label={t('list.label')}
          aria-busy={list.isFetching}
        >
          <thead>
            <tr>
              <th>{t('list.item')}</th>
              <th>{t('list.type')}</th>
              <th className={tbl.num}>{t('list.price')}</th>
              <th>{t('list.status')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.id}
                tabIndex={0}
                aria-selected={item.id === selectedId}
                className={cx(item.id === selectedId && tbl.sel, !item.isActive && tbl.off)}
                onClick={() => setSelectedId(item.id)}
                onKeyDown={(event) => onRowKey(event, item.id)}
              >
                <td>
                  <div className={tbl.who}>
                    <span className={styles.rowTile}>
                      <ItemIcon type={item.itemType} />
                    </span>
                    <span>
                      <b>{name(item)}</b>
                      <span className={tbl.sub}>
                        <bdi>{item.code}</bdi>
                      </span>
                    </span>
                  </div>
                </td>
                <td>
                  <TypeLabel type={item.itemType} />
                </td>
                <td className={tbl.num}>
                  <PriceCell item={item} rateBp={rates.get(item.vatCategoryId)} />
                </td>
                <td>
                  <StatusChip active={item.isActive} />
                </td>
              </tr>
            ))}
            {list.isLoading && (
              <tr className={tbl.empty}>
                <td colSpan={4}>{t('list.loading')}</td>
              </tr>
            )}
          </tbody>
        </table>
        {list.isError && <Alert>{errorText(list.error)}</Alert>}
        {!list.isLoading && !list.isError && items.length === 0 && (
          <EmptyState>{q ? t('list.noMatch') : t('list.empty')}</EmptyState>
        )}
        {shown > 0 && (
          <div className={styles.more}>
            <span className={tbl.sub}>{t('list.shown', { shown, total })}</span>
            {list.hasNextPage && (
              <Button
                variant="ghost"
                busy={list.isFetchingNextPage}
                onPress={() => void list.fetchNextPage()}
              >
                {t('list.more')}
              </Button>
            )}
          </div>
        )}
      </Card>
    </>
  );

  return (
    <div className={pageClasses.page}>
      <PageHeader title={t('title')} subtitle={t('subtitle')} tools={tools} />
      <Kpis>
        <Kpi
          index={1}
          icon={<Package aria-hidden="true" />}
          label={t('kpi.active')}
          value={<bdi>{counts?.active ?? '—'}</bdi>}
        />
        <Kpi
          index={2}
          icon={<Boxes aria-hidden="true" />}
          label={t('kpi.stock')}
          value={<bdi>{counts?.stock ?? '—'}</bdi>}
        />
        <Kpi
          index={3}
          icon={<Wrench aria-hidden="true" />}
          label={t('kpi.service')}
          value={<bdi>{counts?.service ?? '—'}</bdi>}
        />
        <Kpi
          index={4}
          icon={<Layers aria-hidden="true" />}
          label={t('kpi.bundle')}
          value={<bdi>{counts?.bundle ?? '—'}</bdi>}
        />
      </Kpis>
      <SplitView
        list={listPart}
        detail={
          selectedId ? (
            <ItemCard
              key={selectedId}
              id={selectedId}
              onEdit={(item) => setDialog({ kind: 'edit', item })}
            />
          ) : (
            <Card rise index={7}>
              <EmptyState>{t('detail.select')}</EmptyState>
            </Card>
          )
        }
      />
      {(dialog?.kind === 'new' || dialog?.kind === 'edit') && (
        <ItemDialog
          item={dialog.kind === 'edit' ? dialog.item : undefined}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            setSelectedId(saved.id);
          }}
        />
      )}
      {dialog?.kind === 'import' && (
        <ImportDialog
          entity={dialog.entity}
          title={dialog.entity === 'items' ? t('import.itemsTitle') : t('import.pricesTitle')}
          intro={dialog.entity === 'items' ? t('import.itemsIntro') : t('import.pricesIntro')}
          invalidate={[MD_KEYS.items]}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
