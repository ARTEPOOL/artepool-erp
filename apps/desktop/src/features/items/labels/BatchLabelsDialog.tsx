import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Printer, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  DEFAULT_LABEL_PRINTER,
  defaultLabelDesign,
  MAX_LABELS_PER_PRINT,
  type AdjustmentDetail,
  type AdjustmentsResponse,
  type ItemsResponse,
  type LabelItem,
  type LabelItemsResponse,
  type LabelPrinterConfig,
  type LabelSizeItem,
  type PriceChangedItem,
  type PriceChangedResponse,
} from '@artepool/shared/contracts';
import { useApi } from '../../../api/hooks';
import { dubaiDay } from '../../../lib/format';
import {
  Alert,
  Button,
  Chip,
  cx,
  Dialog,
  DialogFooter,
  iconClass,
  Note,
  Segmented,
  SelectField,
  tableClasses as tbl,
  useToast,
} from '../../../ui';
import { useCan } from '../../auth/context';
import { money } from '../../masterdata/format';
import { localName, useCategories, useLabelSizes, useUnits } from '../../masterdata/refs';
import mdStyles from '../../masterdata/masterdata.module.css';
import { useScanInput } from '../scan';
import { drawLabel, labelContent, useLabelDesign } from './design';
import { canPrintLabelsSilently, printLabels, useLabelPrinter } from './printer';
import {
  CONFIRM_ABOVE,
  defaultCopies,
  PRICE_CHANGED_KEY,
  printedPrice,
  useRecordLabelPrints,
} from './record';
import { canvasMeasurer, printedDotsUrl } from './render';
import { labelWords } from './words';
import styles from './labels.module.css';

type Source = 'list' | 'stock_document' | 'price_changed';

interface Line {
  item: LabelItem;
  copies: string;
  /** "Price changed" list: the price on the last label. */
  printed?: PriceChangedItem['printed'];
  nowGrossFils?: string | null;
}

/** The request sizes the server takes: at most 500 items and 5,000 labels per record. */
const RECORD_LINES = 500;

const sizeVars = (size: Pick<LabelSizeItem, 'widthMm' | 'heightMm'>) =>
  ({ '--label-w': `${size.widthMm}mm`, '--label-h': `${size.heightMm}mm` }) as CSSProperties;

const copiesOf = (text: string): number | null =>
  /^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : null;

/**
 * Labels for many items at once (decision 0099): items added by search or scanner, the items of a
 * stock increase or the opening stock (one label per unit received), or the items whose price
 * changed since their last label (one per unit on hand; one for items sold by weight or length).
 * One size and the saved design for all; the total is shown, and more than 100 labels are confirmed
 * first. Every print is recorded with the price on the label.
 */
export function BatchLabelsDialog(props: { onClose: () => void }) {
  const { t, i18n } = useTranslation('items');
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const name = localName(i18n.language);
  const sizes = useLabelSizes();
  const units = useUnits();
  const categories = useCategories();
  const designQuery = useLabelDesign();
  const printer: LabelPrinterConfig = useLabelPrinter().data ?? DEFAULT_LABEL_PRINTER;
  const recordPrints = useRecordLabelPrints();
  const scan = useScanInput();
  const active = (sizes.data ?? [])
    .filter((s) => s.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const [source, setSource] = useState<Source>('list');
  const [lines, setLines] = useState<Line[]>([]);
  const [sizeId, setSizeId] = useState('');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [docId, setDocId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [dialogPrint, setDialogPrint] = useState<Drawn[] | null>(null);
  const [askPrinted, setAskPrinted] = useState<Drawn[] | null>(null);

  const size = active.find((s) => s.id === sizeId) ?? active[0];
  const design = designQuery.data?.design ?? defaultLabelDesign();
  const silent = canPrintLabelsSilently(printer);

  const found = useQuery({
    queryKey: ['label-batch-search', search.trim()],
    queryFn: () =>
      api.get<ItemsResponse>(
        `/api/v1/items?status=active&pageSize=8&q=${encodeURIComponent(search.trim())}`,
      ),
    enabled: source === 'list' && search.trim().length >= 2,
  });
  const docs = useQuery({
    queryKey: ['label-batch-documents'],
    queryFn: () => api.get<AdjustmentsResponse>('/api/v1/stock/adjustments?pageSize=50'),
    enabled: source === 'stock_document',
    select: (r) =>
      r.adjustments.filter(
        (a) => a.status === 'posted' && (a.kind === 'increase' || a.kind === 'opening'),
      ),
  });
  const changed = useQuery({
    queryKey: [...PRICE_CHANGED_KEY, categoryId],
    queryFn: () =>
      api.get<PriceChangedResponse>(
        `/api/v1/label-prints/price-changed${categoryId ? `?categoryId=${categoryId}` : ''}`,
      ),
    enabled: source === 'price_changed',
  });
  // The "price changed" list fills the lines (again after each print or another category).
  useEffect(() => {
    if (source !== 'price_changed' || !changed.data) return;
    setLines(
      changed.data.items.map((item) => ({
        item,
        copies: String(defaultCopies(item, item.onHandMilli)),
        printed: item.printed,
        nowGrossFils: item.nowGrossFils,
      })),
    );
  }, [source, changed.data]);

  const chooseSource = (next: Source) => {
    setSource(next);
    setLines([]);
    setDocId('');
    setConfirming(false);
    setProblem(null);
  };

  /** Adds items (by id) to the list; a stock document gives each its quantity received. */
  const addItems = async (ids: string[], received?: Map<string, bigint>) => {
    if (ids.length === 0) return;
    const { items } = await api.get<LabelItemsResponse>(`/api/v1/label-items?ids=${ids.join(',')}`);
    setLines((current) => {
      if (received) {
        return items.map((item) => ({
          item,
          copies: String(defaultCopies(item, (received.get(item.id) ?? 0n).toString())),
        }));
      }
      const next = [...current];
      for (const item of items) {
        const at = next.findIndex((l) => l.item.id === item.id);
        if (at === -1) next.push({ item, copies: '1' });
        else next[at] = { ...next[at]!, copies: String((copiesOf(next[at]!.copies) ?? 0) + 1) };
      }
      return next;
    });
  };

  const chooseDocument = async (id: string) => {
    setDocId(id);
    setLines([]);
    if (!id) return;
    const doc = await api.get<AdjustmentDetail>(`/api/v1/stock/adjustments/${id}`);
    const received = new Map<string, bigint>();
    for (const l of doc.lines) {
      received.set(l.itemId, (received.get(l.itemId) ?? 0n) + BigInt(l.quantityMilli));
    }
    await addItems([...received.keys()], received);
  };

  // Every label drawn at the printer's dots: what prints is what the preview of one item shows.
  const measurer = useMemo(() => canvasMeasurer(), []);
  const words = useMemo(() => labelWords(i18n), [i18n]);
  const drawn = useMemo(
    () =>
      size
        ? lines.map((line) => {
            const content = labelContent(line.item, {
              design,
              shopName: designQuery.data?.shopName ?? null,
              units: units.data ?? [],
              rateBp: line.item.rateBp,
              withPrice: true,
              extras: { expiry: '', batch: '' },
              today: dubaiDay(),
            });
            return {
              line,
              copies: copiesOf(line.copies),
              ...drawLabel({ size, printer, design, content, words, measurer }),
            };
          })
        : [],
    [lines, size, design, designQuery.data, units.data, printer, words, measurer],
  );
  type Drawn = (typeof drawn)[number];
  const toPrint = drawn.filter((d) => (d.copies ?? 0) > 0 && d.layout.ok);
  const total = toPrint.reduce((sum, d) => sum + d.copies!, 0);
  const badCount = drawn.some((d) => d.copies === null);
  const tooMany = total > MAX_LABELS_PER_PRINT;
  const wontFit = drawn.filter((d) => (d.copies ?? 0) > 0 && !d.layout.ok).length;

  /** Tells the server what was printed (in parts of at most 500 items and 5,000 labels). */
  const record = async (printed: Drawn[]) => {
    if (!size || !designQuery.data || printed.length === 0) return;
    const changedCodes: string[] = [];
    let part: Drawn[] = [];
    const parts: Drawn[][] = [];
    let labels = 0;
    for (const d of printed) {
      if (part.length === RECORD_LINES || labels + d.copies! > MAX_LABELS_PER_PRINT) {
        parts.push(part);
        part = [];
        labels = 0;
      }
      part.push(d);
      labels += d.copies!;
    }
    parts.push(part);
    try {
      for (const chunk of parts) {
        const result = await recordPrints.mutateAsync({
          sizeId: size.id,
          designVersionId: designQuery.data.versionId,
          source,
          lines: chunk.map((d) => ({
            itemId: d.line.item.id,
            copies: d.copies!,
            price: printedPrice(d.line.item.price, d.line.item.rateBp, true),
          })),
        });
        for (const id of result.priceChanged) {
          const item = chunk.find((d) => d.line.item.id === id)?.line.item;
          if (item) changedCodes.push(item.code);
        }
      }
      setProblem(
        changedCodes.length > 0
          ? t('labels.batch.priceChanged', { codes: changedCodes.join('، ') })
          : null,
      );
    } catch {
      setProblem(t('labels.notRecorded'));
    }
  };

  // The print dialog (no label printer here): all the labels in a print-only container, one page
  // each; afterwards the person says whether they printed (a cancelled dialog also says "done").
  const recordRef = useRef(record);
  recordRef.current = record;
  useEffect(() => {
    if (!dialogPrint || !size) return;
    const style = document.createElement('style');
    style.textContent = `@page { size: ${size.widthMm}mm ${size.heightMm}mm; margin: 0; }`;
    document.head.appendChild(style);
    const sent = dialogPrint;
    const done = () => {
      setDialogPrint(null);
      setAskPrinted(sent);
    };
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    return () => {
      window.removeEventListener('afterprint', done);
      style.remove();
    };
  }, [dialogPrint, size]);

  const print = async () => {
    if (!size || total === 0 || tooMany || badCount) return;
    if (total > CONFIRM_ABOVE && !confirming) return setConfirming(true);
    setConfirming(false);
    setProblem(null);
    if (!silent) return setDialogPrint(toPrint);
    setBusy(true);
    const sent: Drawn[] = [];
    for (const d of toPrint) {
      if (!d.image) break;
      const outcome = await printLabels(
        d.image,
        size,
        printer,
        d.copies!,
        `labels-${d.line.item.code}`,
      );
      if (!outcome.printed) {
        setProblem(t(`labels.problem.${outcome.reason}`));
        break;
      }
      sent.push(d);
    }
    if (sent.length > 0) {
      toast(t('labels.sent', { count: sent.reduce((sum, d) => sum + d.copies!, 0) }));
      await record(sent);
    }
    setBusy(false);
  };

  const setCopies = (id: string, copies: string) =>
    setLines((current) => current.map((l) => (l.item.id === id ? { ...l, copies } : l)));
  const remove = (id: string) => setLines((current) => current.filter((l) => l.item.id !== id));
  const topCategories = (categories.data ?? []).filter((c) => c.isActive && !c.parentId);

  return (
    <Dialog isOpen wide onClose={props.onClose} title={t('labels.batch.title')}>
      <div className={mdStyles.form}>
        <Segmented
          label={t('labels.batch.source')}
          value={source}
          onChange={chooseSource}
          options={[
            { value: 'list' as const, label: t('labels.batch.sources.list') },
            ...(can('stock.view')
              ? [
                  {
                    value: 'stock_document' as const,
                    label: t('labels.batch.sources.stock_document'),
                  },
                ]
              : []),
            { value: 'price_changed' as const, label: t('labels.batch.sources.price_changed') },
          ]}
        />
        <div className={mdStyles.grid2}>
          {source === 'list' && (
            <div>
              <label className={styles.searchLabel}>
                <span>{t('labels.batch.search')}</span>
                <input
                  type="search"
                  className={styles.cellInput}
                  value={search}
                  autoComplete="off"
                  aria-label={t('labels.batch.search')}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    scan.onKeyDown(event);
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    const typed = scan.read(event.currentTarget.value.trim());
                    if (!typed) return;
                    void api
                      .get<ItemsResponse>(
                        `/api/v1/items?status=active&pageSize=8&q=${encodeURIComponent(typed)}`,
                      )
                      .then((r) => {
                        const only =
                          r.exactMatchId ?? (r.items.length === 1 ? r.items[0]!.id : null);
                        if (only) {
                          setSearch('');
                          return addItems([only]);
                        }
                        setSearch(typed);
                      });
                  }}
                />
              </label>
              {search.trim().length >= 2 && (found.data?.items.length ?? 0) > 0 && (
                <ul className={styles.results} aria-label={t('labels.batch.results')}>
                  {found.data!.items.map((item) => (
                    <li key={item.id}>
                      <span>
                        {name(item)} · <bdi>{item.code}</bdi>
                      </span>
                      <Button
                        onPress={() => {
                          setSearch('');
                          void addItems([item.id]);
                        }}
                      >
                        {t('labels.batch.add')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {source === 'stock_document' && (
            <SelectField
              id="labels-batch-document"
              label={t('labels.batch.document')}
              value={docId}
              onChange={(id) => void chooseDocument(id)}
              options={[
                { value: '', label: t('labels.batch.chooseDocument') },
                ...(docs.data ?? []).map((a) => ({
                  value: a.id,
                  label: `${a.docNumber} · ${a.date} · ${t(`labels.batch.kinds.${a.kind}`)}`,
                })),
              ]}
            />
          )}
          {source === 'price_changed' && (
            <SelectField
              id="labels-batch-category"
              label={t('labels.batch.category')}
              value={categoryId}
              onChange={setCategoryId}
              options={[
                { value: '', label: t('labels.batch.allCategories') },
                ...topCategories.map((c) => ({ value: c.id, label: name(c) })),
              ]}
            />
          )}
          <SelectField
            id="labels-batch-size"
            label={t('labels.size')}
            value={size?.id ?? ''}
            onChange={setSizeId}
            options={active.map((s) => ({
              value: s.id,
              label: `${name(s)} (${s.widthMm} × ${s.heightMm})`,
            }))}
          />
        </div>

        {lines.length === 0 ? (
          <Note>
            {source === 'price_changed' && changed.isSuccess
              ? t('labels.batch.nothingChanged')
              : t(`labels.batch.empty.${source}`)}
          </Note>
        ) : (
          <div className={styles.batchTable}>
            <table className={tbl.table} aria-label={t('labels.batch.lines')}>
              <thead>
                <tr>
                  <th>{t('labels.batch.item')}</th>
                  {source === 'price_changed' && <th>{t('labels.batch.oldNew')}</th>}
                  <th>{t('labels.count')}</th>
                  <th aria-label={t('labels.batch.remove')} />
                </tr>
              </thead>
              <tbody>
                {drawn.map((d) => (
                  <tr key={d.line.item.id} data-testid={`labels-line-${d.line.item.code}`}>
                    <td>
                      <b>{name(d.line.item)}</b>
                      <span className={tbl.sub}>
                        <bdi>{d.line.item.code}</bdi>
                      </span>
                      {!d.layout.ok && (
                        <Chip tone="warn">{t(`labels.refused.${d.layout.reason}`)}</Chip>
                      )}
                    </td>
                    {source === 'price_changed' && (
                      <td>
                        <bdi>
                          {d.line.printed ? money(BigInt(d.line.printed.grossFils)) : '—'} →{' '}
                          {d.line.nowGrossFils ? money(BigInt(d.line.nowGrossFils)) : '—'}
                        </bdi>
                      </td>
                    )}
                    <td>
                      <input
                        className={cx(styles.cellInput, d.copies === null && styles.bad)}
                        dir="ltr"
                        inputMode="numeric"
                        aria-label={t('labels.batch.countOf', { name: name(d.line.item) })}
                        value={d.line.copies}
                        onChange={(event) => setCopies(d.line.item.id, event.target.value)}
                      />
                    </td>
                    <td>
                      <Button
                        variant="ghost"
                        aria-label={t('labels.batch.removeOf', { name: name(d.line.item) })}
                        onPress={() => remove(d.line.item.id)}
                      >
                        <Trash2 className={iconClass.sm} aria-hidden="true" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className={styles.total} data-testid="labels-total">
          {t('labels.batch.total', { count: total })}
        </p>
        {wontFit > 0 && <Note>{t('labels.batch.wontFit', { count: wontFit })}</Note>}
        {badCount && <Alert>{t('labels.batch.badCount')}</Alert>}
        {tooMany && <Alert>{t('labels.batch.tooMany', { max: MAX_LABELS_PER_PRINT })}</Alert>}
        {confirming && (
          <Alert tone="warn">
            {t('labels.batch.confirm', { count: total })}{' '}
            <Button variant="primary" onPress={() => void print()}>
              {t('labels.batch.confirmYes')}
            </Button>{' '}
            <Button onPress={() => setConfirming(false)}>{t('labels.batch.confirmNo')}</Button>
          </Alert>
        )}
        {askPrinted && (
          <Note>
            {t('labels.didPrint', { count: askPrinted.reduce((s, d) => s + d.copies!, 0) })}{' '}
            <Button
              onPress={() => {
                const sent = askPrinted;
                setAskPrinted(null);
                void recordRef.current(sent);
              }}
            >
              {t('labels.didPrintYes')}
            </Button>{' '}
            <Button onPress={() => setAskPrinted(null)}>{t('labels.didPrintNo')}</Button>
          </Note>
        )}
        {!silent && total > 0 && <Note>{t('labels.dialogNote')}</Note>}
        {problem && <Alert>{problem}</Alert>}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('adjust.cancel')}</Button>
          <Button
            variant="primary"
            busy={busy}
            isDisabled={!size || total === 0 || tooMany || badCount || confirming}
            onPress={() => void print()}
          >
            <Printer className={iconClass.sm} aria-hidden="true" />
            {t('labels.batch.print', { count: total })}
          </Button>
        </DialogFooter>
      </div>
      {dialogPrint &&
        size &&
        createPortal(
          <div className={styles.printRoll} style={sizeVars(size)} data-testid="label-print">
            {dialogPrint.flatMap((d) =>
              Array.from({ length: d.copies! }, (_, i) => (
                <img
                  key={`${d.line.item.id}-${i}`}
                  className={styles.label}
                  src={d.image ? printedDotsUrl(d.image) : undefined}
                  alt=""
                />
              )),
            )}
          </div>,
          document.body,
        )}
    </Dialog>
  );
}
