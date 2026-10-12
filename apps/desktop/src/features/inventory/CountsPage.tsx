import { useState, type FormEvent } from 'react';
import { ClipboardList, Lock, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import type {
  CountDetail,
  CountItem,
  CreateCountRequest,
  ItemListItem,
} from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { useSave } from '../../api/hooks';
import { formatDate } from '../../lib/format';
import {
  Alert,
  Button,
  Card,
  cx,
  Dialog,
  DialogFooter,
  EmptyState,
  IconButton,
  iconClass,
  InfoBar,
  pageClasses,
  PageHeader,
  Segmented,
  SelectField,
  tableClasses as tbl,
  TextField,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { money } from '../masterdata/format';
import { localName, useCategories } from '../masterdata/refs';
import { STOCK_INVALIDATE, STOCK_PATHS, useCounts } from './api';
import { CountStatusChip, StockItemPicker } from './parts';
import styles from './inventory.module.css';

type Scope = CreateCountRequest['scope'];

/** How far the counting has got: "12 / 40" with a bar. */
export function Progress({ done, total }: { done: number; total: number }) {
  const { t } = useTranslation('inventory');
  const percent = total === 0 ? 0 : Math.round((done * 100) / total);
  return (
    <div className={styles.progress}>
      <span className={tbl.sub}>
        {t('counts.progress', { done: String(done), total: String(total) })}
      </span>
      <div
        className={styles.progressTrack}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label={t('counts.progressLabel')}
      >
        <div className={styles.progressFill} style={{ inlineSize: `${percent}%` }} />
      </div>
    </div>
  );
}

/** A new count: everything, one category, or chosen items. Only one count may be open. */
function NewCountDialog(props: { onClose: () => void; onCreated: (count: CountDetail) => void }) {
  const { t, i18n } = useTranslation('inventory');
  const { t: tm } = useTranslation('masterdata');
  const name = localName(i18n.language);
  const errorText = useErrorText();
  const categories = useCategories();
  const [scope, setScope] = useState<Scope>('full');
  const [categoryId, setCategoryId] = useState('');
  const [chosen, setChosen] = useState<ItemListItem[]>([]);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const create = useSave(
    (a, body: CreateCountRequest, key) =>
      a.post<CountDetail>(STOCK_PATHS.counts, body, { idempotencyKey: key }),
    { invalidate: STOCK_INVALIDATE, onSuccess: (count) => props.onCreated(count) },
  );

  const all = categories.data ?? [];
  const parentName = (id: string | null) => {
    const parent = all.find((c) => c.id === id);
    return parent ? `${name(parent)} / ` : '';
  };
  const categoryOptions = all
    .filter((c) => c.isActive)
    .map((c) => ({ value: c.id, label: `${parentName(c.parentId)}${name(c)}` }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (scope === 'category' && !categoryId) return setProblem(t('counts.new.chooseCategory'));
    if (scope === 'selected' && chosen.length === 0) return setProblem(t('counts.new.chooseItems'));
    create.mutate({
      scope,
      ...(scope === 'category' ? { categoryId } : {}),
      ...(scope === 'selected' ? { itemIds: chosen.map((i) => i.id) } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  };

  const duplicate = create.error instanceof ApiError && create.error.code === 'DUPLICATE';
  return (
    <Dialog isOpen onClose={props.onClose} title={t('counts.new.title')}>
      <form onSubmit={submit} noValidate className={styles.form}>
        <InfoBar>{t('counts.new.explain')}</InfoBar>
        <Segmented
          label={t('counts.new.scope')}
          value={scope}
          onChange={setScope}
          block
          options={[
            { value: 'full', label: t('counts.scope.full') },
            { value: 'category', label: t('counts.scope.category') },
            { value: 'selected', label: t('counts.scope.selected') },
          ]}
        />
        {scope === 'category' && (
          <SelectField
            id="count-category"
            label={t('counts.new.category')}
            value={categoryId}
            onChange={setCategoryId}
            options={[{ value: '', label: t('counts.new.choose') }, ...categoryOptions]}
          />
        )}
        {scope === 'selected' && (
          <>
            <StockItemPicker
              taken={new Set(chosen.map((i) => i.id))}
              onAdd={(item) => setChosen((list) => [...list, item])}
            />
            {chosen.length > 0 && (
              <ul className={styles.chosen} aria-label={t('counts.new.chosen')}>
                {chosen.map((item) => (
                  <li key={item.id}>
                    <span>
                      {name(item)} <bdi className={styles.muted}>{item.code}</bdi>
                    </span>
                    <IconButton
                      aria-label={t('counts.new.remove', { name: name(item) })}
                      onPress={() => setChosen((list) => list.filter((i) => i.id !== item.id))}
                    >
                      <X className={iconClass.sm} aria-hidden="true" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <TextField label={t('counts.new.note')} value={note} onChange={setNote} multiline />
        {problem && <Alert>{problem}</Alert>}
        {create.error !== null && (
          <Alert>{duplicate ? t('counts.new.duplicate') : errorText(create.error)}</Alert>
        )}
        <DialogFooter>
          <Button onPress={props.onClose}>{tm('actions.cancel')}</Button>
          <Button type="submit" variant="primary" busy={create.isPending}>
            {t('counts.new.start')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Stock counts (decision 0044): the list, and a new count. Opening one goes to its page. */
export function CountsPage() {
  const { t } = useTranslation('inventory');
  const can = useCan();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const allowed = can('stock.count');
  const counts = useCounts(allowed);
  const values = can('stock.view_cost');
  const list: CountItem[] = counts.data?.counts ?? [];

  const open = (id: string) =>
    void navigate({ to: '/stock/counts/$countId', params: { countId: id } });

  const tools = allowed && (
    <Button variant="primary" onPress={() => setCreating(true)}>
      <Plus className={iconClass.sm} aria-hidden="true" />
      {t('counts.new.button')}
    </Button>
  );

  return (
    <div className={pageClasses.page}>
      <PageHeader title={t('counts.title')} subtitle={t('counts.subtitle')} tools={tools} />
      {!allowed ? (
        <InfoBar icon={<Lock aria-hidden="true" />}>{t('noAccess')}</InfoBar>
      ) : (
        <Card rise index={1} padding="table">
          <table className={cx(tbl.table, tbl.selectable)} aria-label={t('counts.list.label')}>
            <thead>
              <tr>
                <th>{t('fields.number')}</th>
                <th>{t('fields.status')}</th>
                <th>{t('counts.list.scope')}</th>
                <th>{t('counts.list.created')}</th>
                <th>{t('counts.list.progress')}</th>
                {values && <th className={tbl.num}>{t('counts.list.difference')}</th>}
              </tr>
            </thead>
            <tbody>
              {list.map((count) => (
                <tr
                  key={count.id}
                  tabIndex={0}
                  onClick={() => open(count.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      open(count.id);
                    }
                  }}
                >
                  <td className={styles.numberCell}>
                    {count.docNumber ? (
                      <bdi>{count.docNumber}</bdi>
                    ) : (
                      <span className={styles.muted}>{t('counts.list.counting')}</span>
                    )}
                  </td>
                  <td>
                    <CountStatusChip status={count.status} />
                  </td>
                  <td>{t(`counts.scope.${count.scope}`)}</td>
                  <td>
                    <bdi>{formatDate(count.createdAt)}</bdi>
                  </td>
                  <td>
                    <Progress done={count.countedLines} total={count.lineCount} />
                  </td>
                  {values && (
                    <td className={tbl.num}>
                      <bdi>
                        {count.status === 'posted' && count.totalValueFils
                          ? money(BigInt(count.totalValueFils))
                          : '—'}
                      </bdi>
                    </td>
                  )}
                </tr>
              ))}
              {counts.isLoading && (
                <tr className={tbl.empty}>
                  <td colSpan={values ? 6 : 5}>{t('loading')}</td>
                </tr>
              )}
            </tbody>
          </table>
          {counts.isError && <Alert>{errorText(counts.error)}</Alert>}
          {counts.isSuccess && list.length === 0 && (
            <EmptyState>
              <ClipboardList className={styles.emptyIcon} aria-hidden="true" />
              {t('counts.list.empty')}
            </EmptyState>
          )}
        </Card>
      )}
      {creating && (
        <NewCountDialog
          onClose={() => setCreating(false)}
          onCreated={(count) => {
            setCreating(false);
            open(count.id);
          }}
        />
      )}
    </div>
  );
}
