import { useState } from 'react';
import { CheckCircle2, FileSpreadsheet, Lock, Send, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { lineAmountFils } from '@artepool/shared';
import type {
  AdjustmentDetail,
  AdjustmentItem,
  CreateAdjustmentRequest,
  ItemDetail,
  ItemListItem,
} from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { useApi, useSave } from '../../api/hooks';
import { formatDate, dubaiDay } from '../../lib/format';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  cx,
  DefinitionList,
  EmptyState,
  IconButton,
  iconClass,
  InfoBar,
  pageClasses,
  PageHeader,
  tableClasses as tbl,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { ImportDialog } from '../masterdata/ImportDialog';
import { money, price } from '../masterdata/format';
import { localName, MD_KEYS, useReasonCodes, useUnits } from '../masterdata/refs';
import { STOCK_INVALIDATE, STOCK_PATHS, useAdjustment, useAdjustments } from './api';
import {
  quantityShort,
  readCost,
  readQuantity,
  SaveError,
  StockItemPicker,
  useUnitOf,
  type QuantityProblem,
} from './parts';
import styles from './inventory.module.css';

interface Row {
  key: string;
  itemId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  unitId: string;
  qty: string;
  cost: string;
  /** Hints for the cost field: the current average (stock.view_cost), the purchase price (owner). */
  avg4dp: string | null;
  purchase4dp: string | null;
}

type RowProblems = Record<string, { qty?: QuantityProblem; cost?: boolean; costUnknown?: boolean }>;

let nextKey = 0;
const rowKey = () => `row-${++nextKey}`;

/** One posted adjustment: its number, journal entry and lines (values only when allowed). */
function AdjustmentCard({ doc, onClose }: { doc: AdjustmentDetail; onClose?: () => void }) {
  const { t, i18n } = useTranslation('inventory');
  const name = localName(i18n.language);
  const can = useCan();
  const units = useUnits();
  const unitOf = useUnitOf(units.data);
  const values = can('stock.view_cost');
  return (
    <Card rise padding="table" aria-label={t('opening.posted.label')}>
      <CardHeader title={<bdi>{doc.docNumber ?? '—'}</bdi>}>
        {onClose && (
          <IconButton aria-label={t('actions.close')} onPress={onClose}>
            <X className={iconClass.sm} aria-hidden="true" />
          </IconButton>
        )}
      </CardHeader>
      <div className={styles.cardBody}>
        <DefinitionList
          rows={[
            { label: t('fields.date'), value: <bdi>{formatDate(doc.date)}</bdi> },
            {
              label: t('fields.journalEntry'),
              value: <bdi>{doc.journalEntryNumber ?? '—'}</bdi>,
            },
            ...(values && doc.totalValueFils
              ? [
                  {
                    label: t('fields.value'),
                    value: <bdi>{money(BigInt(doc.totalValueFils))}</bdi>,
                  },
                ]
              : []),
          ]}
        />
        <table className={tbl.table} aria-label={t('opening.posted.lines')}>
          <thead>
            <tr>
              <th>{t('fields.item')}</th>
              <th className={tbl.num}>{t('fields.quantity')}</th>
              {values && <th className={tbl.num}>{t('fields.unitCost')}</th>}
              {values && <th className={tbl.num}>{t('fields.value')}</th>}
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((line) => (
              <tr key={line.lineNo}>
                <td>
                  <b>{name(line)}</b>
                  <span className={tbl.sub}>
                    <bdi>{line.itemCode}</bdi>
                  </span>
                </td>
                <td className={tbl.num}>
                  <bdi>{quantityShort(BigInt(line.quantityMilli))}</bdi> {unitOf(line.unitId).name}
                </td>
                {values && (
                  <td className={tbl.num}>
                    <bdi>{line.unitCost4dp ? price(BigInt(line.unitCost4dp)) : '—'}</bdi>
                  </td>
                )}
                {values && (
                  <td className={tbl.num}>
                    <bdi>{line.valueFils ? money(BigInt(line.valueFils)) : '—'}</bdi>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** The opening stock entry form: items, quantities, costs, the date; then one POST. */
function OpeningForm({ onPosted }: { onPosted: (doc: AdjustmentDetail) => void }) {
  const { t, i18n } = useTranslation('inventory');
  const name = localName(i18n.language);
  const can = useCan();
  const api = useApi();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const units = useUnits();
  const unitOf = useUnitOf(units.data);
  const reasons = useReasonCodes();
  const [rows, setRows] = useState<Row[]>([]);
  const [date, setDate] = useState(dubaiDay());
  const [problems, setProblems] = useState<RowProblems>({});
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const values = can('stock.view_cost');

  const opening = (reasons.data ?? []).find((r) => r.category === 'other' && r.code === 'OPENING');

  const post = useSave(
    (a, body: CreateAdjustmentRequest, key) =>
      a.post<AdjustmentDetail>(STOCK_PATHS.adjustments, body, { idempotencyKey: key }),
    {
      invalidate: STOCK_INVALIDATE,
      onSuccess: (doc) => {
        setRows([]);
        setProblems({});
        onPosted(doc);
      },
    },
  );

  const add = (item: ItemListItem) => {
    const key = rowKey();
    setRows((list) => [
      ...list,
      {
        key,
        itemId: item.id,
        code: item.code,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        unitId: item.unitId,
        qty: '',
        cost: '',
        avg4dp: item.stock?.avgUnitCost4dp ?? null,
        purchase4dp: null,
      },
    ]);
    // The purchase price (owner only, decision 0038) is what an empty cost will use.
    if (can('items.cost')) {
      void queryClient
        .fetchQuery({
          queryKey: MD_KEYS.item(item.id),
          queryFn: () => api.get<ItemDetail>(`/api/v1/items/${item.id}`),
        })
        .then((detail) =>
          setRows((list) =>
            list.map((r) =>
              r.key === key ? { ...r, purchase4dp: detail.purchaseCost4dp ?? null } : r,
            ),
          ),
        )
        .catch(() => undefined);
    }
  };
  const update = (key: string, patch: Partial<Row>) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  // The value preview: typed cost, else the purchase price; unknown while any line has neither.
  const preview = (() => {
    let total = 0n;
    let complete = rows.length > 0;
    for (const r of rows) {
      const qty = readQuantity(r.qty, unitOf(r.unitId).decimals, false);
      const cost = readCost(r.cost);
      const unit = cost.ok ? (cost.value ?? (r.purchase4dp ? BigInt(r.purchase4dp) : null)) : null;
      if (!qty.ok || unit === null) complete = false;
      else total += lineAmountFils(qty.value, unit);
    }
    return { total, complete };
  })();

  const submit = () => {
    setFormProblem(null);
    post.reset();
    if (rows.length === 0) return setFormProblem(t('opening.form.noLines'));
    if (!opening) return setFormProblem(t('opening.form.noReason'));
    const found: RowProblems = {};
    const lines: CreateAdjustmentRequest['lines'] = [];
    for (const r of rows) {
      const qty = readQuantity(r.qty, unitOf(r.unitId).decimals, false);
      const cost = readCost(r.cost);
      if (!qty.ok) found[r.key] = { qty: qty.problem };
      if (!cost.ok) found[r.key] = { ...found[r.key], cost: true };
      if (qty.ok && cost.ok) {
        lines.push({
          itemId: r.itemId,
          quantityMilli: qty.value.toString(),
          ...(cost.value !== null ? { unitCost4dp: cost.value.toString() } : {}),
        });
      }
    }
    setProblems(found);
    if (Object.keys(found).length > 0) return setFormProblem(t('opening.form.fix'));
    post.mutate(
      { kind: 'opening', reasonCodeId: opening.id, date, lines },
      {
        onError: (error) => {
          const itemId = error instanceof ApiError ? error.details.itemId : undefined;
          const row = rows.find((r) => r.itemId === itemId);
          if (row) setProblems({ [row.key]: { costUnknown: true } });
        },
      },
    );
  };

  const qtyText = (problem: QuantityProblem | undefined) =>
    problem ? t(`problems.${problem}`) : undefined;

  return (
    <Card rise index={2} padding="table">
      <CardHeader title={t('opening.form.title')}>
        <label className={styles.dateField}>
          <span>{t('fields.date')}</span>
          <input
            type="date"
            dir="ltr"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
      </CardHeader>
      <div className={styles.cardBody}>
        <StockItemPicker taken={new Set(rows.map((r) => r.itemId))} onAdd={add} />
        <table className={tbl.table} aria-label={t('opening.form.lines')}>
          <thead>
            <tr>
              <th>{t('fields.item')}</th>
              <th>{t('fields.quantity')}</th>
              <th>{t('fields.unitCost')}</th>
              {values && <th className={tbl.num}>{t('fields.value')}</th>}
              <th>
                <span className={styles.visuallyHidden}>{t('actions.remove')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const unit = unitOf(r.unitId);
              const p = problems[r.key];
              const qty = readQuantity(r.qty, unit.decimals, false);
              const cost = readCost(r.cost);
              const unitCost = cost.ok
                ? (cost.value ?? (r.purchase4dp ? BigInt(r.purchase4dp) : null))
                : null;
              return (
                <tr key={r.key} className={cx(p && styles.badRow)}>
                  <td>
                    <b>{name(r)}</b>
                    <span className={tbl.sub}>
                      <bdi>{r.code}</bdi>
                    </span>
                  </td>
                  <td>
                    <div className={styles.qtyCell}>
                      <input
                        className={cx(styles.cellInput, p?.qty && styles.bad)}
                        dir="ltr"
                        inputMode="decimal"
                        aria-label={t('opening.form.quantityOf', { name: name(r) })}
                        aria-invalid={p?.qty ? true : undefined}
                        value={r.qty}
                        onChange={(event) => update(r.key, { qty: event.target.value })}
                      />
                      <span className={styles.muted}>{unit.name}</span>
                    </div>
                    {p?.qty && (
                      <span className={styles.fieldError}>
                        {qtyText(p.qty)}
                        {p.qty === 'decimals' && unit.decimals === 0 && ` ${t('problems.whole')}`}
                      </span>
                    )}
                  </td>
                  <td>
                    <input
                      className={cx(styles.cellInput, (p?.cost || p?.costUnknown) && styles.bad)}
                      dir="ltr"
                      inputMode="decimal"
                      aria-label={t('opening.form.costOf', { name: name(r) })}
                      aria-invalid={p?.cost || p?.costUnknown ? true : undefined}
                      placeholder={r.purchase4dp ? price(BigInt(r.purchase4dp)) : undefined}
                      value={r.cost}
                      onChange={(event) => update(r.key, { cost: event.target.value })}
                    />
                    {(r.purchase4dp || (values && r.avg4dp)) && (
                      <span className={tbl.sub}>
                        {r.purchase4dp && (
                          <>
                            {t('opening.form.purchaseHint')}{' '}
                            <bdi>{price(BigInt(r.purchase4dp))}</bdi>
                          </>
                        )}
                        {r.purchase4dp && values && r.avg4dp && ' · '}
                        {values && r.avg4dp && (
                          <>
                            {t('opening.form.averageHint')} <bdi>{price(BigInt(r.avg4dp))}</bdi>
                          </>
                        )}
                      </span>
                    )}
                    {p?.cost && <span className={styles.fieldError}>{t('problems.invalid')}</span>}
                    {p?.costUnknown && (
                      <span className={styles.fieldError}>{t('opening.form.costUnknown')}</span>
                    )}
                  </td>
                  {values && (
                    <td className={tbl.num}>
                      <bdi>
                        {qty.ok && unitCost !== null
                          ? money(lineAmountFils(qty.value, unitCost))
                          : '—'}
                      </bdi>
                    </td>
                  )}
                  <td className={tbl.num}>
                    <IconButton
                      aria-label={t('opening.form.removeLine', { name: name(r) })}
                      onPress={() => setRows((list) => list.filter((x) => x.key !== r.key))}
                    >
                      <X className={iconClass.sm} aria-hidden="true" />
                    </IconButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <EmptyState>{t('opening.form.empty')}</EmptyState>}
        {values && rows.length > 0 && (
          <div className={styles.totalRow} data-testid="opening-total">
            <span>{t('opening.form.total')}</span>
            <b>
              <bdi>{preview.complete ? money(preview.total) : '—'}</bdi>
            </b>
            {!preview.complete && <span className={styles.muted}>{t('opening.form.partial')}</span>}
          </div>
        )}
        {formProblem && <Alert>{formProblem}</Alert>}
        {post.error !== null && <SaveError error={post.error} />}
        {reasons.isError && <Alert>{errorText(reasons.error)}</Alert>}
        <div className={styles.actions}>
          <Button variant="primary" busy={post.isPending} onPress={submit}>
            <Send className={iconClass.sm} aria-hidden="true" />
            {t('opening.form.post')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** Posted opening documents (read-only for everyone who may see stock). */
function OpeningList(props: { shownId: string | null; onShow: (id: string) => void }) {
  const { t } = useTranslation('inventory');
  const can = useCan();
  const errorText = useErrorText();
  const list = useAdjustments('opening', undefined, can('stock.view'));
  const values = can('stock.view_cost');
  const docs: AdjustmentItem[] = list.data?.adjustments ?? [];
  return (
    <Card rise index={3} padding="table">
      <CardHeader title={t('opening.list.title')} />
      <table className={cx(tbl.table, tbl.selectable)} aria-label={t('opening.list.title')}>
        <thead>
          <tr>
            <th>{t('fields.number')}</th>
            <th>{t('fields.date')}</th>
            <th className={tbl.num}>{t('fields.lines')}</th>
            {values && <th className={tbl.num}>{t('fields.value')}</th>}
          </tr>
        </thead>
        <tbody>
          {docs.map((doc) => (
            <tr
              key={doc.id}
              tabIndex={0}
              aria-selected={doc.id === props.shownId}
              className={cx(doc.id === props.shownId && tbl.sel)}
              onClick={() => props.onShow(doc.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  props.onShow(doc.id);
                }
              }}
            >
              <td>
                <b>
                  <bdi>{doc.docNumber ?? '—'}</bdi>
                </b>
              </td>
              <td>
                <bdi>{formatDate(doc.date)}</bdi>
              </td>
              <td className={tbl.num}>
                <bdi>{doc.lineCount}</bdi>
              </td>
              {values && (
                <td className={tbl.num}>
                  <bdi>{doc.totalValueFils ? money(BigInt(doc.totalValueFils)) : '—'}</bdi>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {list.isError && <Alert>{errorText(list.error)}</Alert>}
      {list.isSuccess && docs.length === 0 && <EmptyState>{t('opening.list.empty')}</EmptyState>}
    </Card>
  );
}

/**
 * Opening stock (decision 0042): entered once at go-live by the owner, by hand or from Excel.
 * An empty cost takes the item's purchase price; the journal entry is Inventory / Opening
 * balance equity.
 */
export function OpeningStockPage() {
  const { t } = useTranslation('inventory');
  const can = useCan();
  const [importing, setImporting] = useState(false);
  const [posted, setPosted] = useState<AdjustmentDetail | null>(null);
  const [shownId, setShownId] = useState<string | null>(null);
  const shown = useAdjustment(shownId !== null && shownId !== posted?.id ? shownId : null);
  const mayPost = can('stock.opening');

  const tools = mayPost && can('data.import') && (
    <Button onPress={() => setImporting(true)}>
      <FileSpreadsheet className={iconClass.sm} aria-hidden="true" />
      {t('opening.import')}
    </Button>
  );

  const detail = posted && shownId === posted.id ? posted : (shown.data ?? null);

  return (
    <div className={pageClasses.page}>
      <PageHeader title={t('opening.title')} subtitle={t('opening.subtitle')} tools={tools} />
      <InfoBar>{t('opening.explain')}</InfoBar>
      {!mayPost && <InfoBar icon={<Lock aria-hidden="true" />}>{t('opening.ownerOnly')}</InfoBar>}
      {posted && (
        <div role="status" className={styles.success}>
          <CheckCircle2 aria-hidden="true" />
          <span>
            {t('opening.done')} <bdi>{posted.docNumber ?? '—'}</bdi>
            {' · '}
            {t('fields.journalEntry')} <bdi>{posted.journalEntryNumber ?? '—'}</bdi>
          </span>
        </div>
      )}
      {mayPost && (
        <OpeningForm
          onPosted={(doc) => {
            setPosted(doc);
            setShownId(doc.id);
          }}
        />
      )}
      {detail && <AdjustmentCard doc={detail} onClose={() => setShownId(null)} />}
      <OpeningList shownId={shownId} onShow={setShownId} />
      {importing && (
        <ImportDialog
          entity="opening_stock"
          title={t('opening.importTitle')}
          intro={t('opening.importIntro')}
          invalidate={STOCK_INVALIDATE}
          onClose={() => setImporting(false)}
        />
      )}
    </div>
  );
}
