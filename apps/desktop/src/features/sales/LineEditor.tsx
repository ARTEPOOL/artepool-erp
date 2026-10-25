/**
 * The lines of a quotation or an invoice draft: search an item and add it, then quantity, price
 * and discount per line (decision 0012: the discount is kept per line). Amounts update as you
 * type with the same shared helper as the server; the saved document's amounts come from the
 * server. A price different from the item's is marked: it needs sales.price_override or a
 * supervisor's approval when saving.
 */
import { useMemo } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ItemListItem } from '@artepool/shared/contracts';
import { cx, IconButton, iconClass, tableClasses as tbl } from '../../ui';
import { money, price, rate } from '../masterdata/format';
import { localName, useUnits, useVat } from '../masterdata/refs';
import { useSellableItemSearch } from './api';
import { useScanInput } from '../items/scan';
import { useSuggest } from './suggest';
import {
  lineFromItem,
  preview,
  priceChanged,
  readDocDiscount,
  readLine,
  type EditorLine,
  type Preview,
} from './lines';
import styles from './sales.module.css';

/** Unit decimals and VAT rates for the preview. */
export function useLineRefs() {
  const units = useUnits();
  const vat = useVat();
  return useMemo(
    () => ({
      ready: units.data !== undefined && vat.data !== undefined,
      unitDecimalsOf: (unitId: string) => units.data?.find((u) => u.id === unitId)?.decimals ?? 0,
      unitName: (unitId: string, language: string) => {
        const unit = units.data?.find((u) => u.id === unitId);
        return unit ? localName(language)(unit) : '';
      },
      rateOf: (vatCategoryId: string) =>
        vat.data?.categories.find((c) => c.id === vatCategoryId)?.rateBp,
    }),
    [units.data, vat.data],
  );
}

/** The live preview of the lines and the document discount. */
export function useLinesPreview(lines: EditorLine[], docDiscount: string): Preview {
  const refs = useLineRefs();
  return useMemo(
    () => preview(lines, readDocDiscount(docDiscount) ?? 0n, refs.unitDecimalsOf, refs.rateOf),
    [lines, docDiscount, refs],
  );
}

/** Search active, sellable items with a price and add one. */
export function SellableItemPicker(props: { onAdd: (item: ItemListItem) => void }) {
  const { t, i18n } = useTranslation('sales');
  const name = localName(i18n.language);
  const box = useSuggest();
  // A scanned code comes back in Latin letters even with the Arabic keyboard.
  const scan = useScanInput();
  const found = useSellableItemSearch(box.q, box.open || box.q.length > 0);
  const choices = (found.data?.items ?? []).filter((i) => i.isActive);
  const sellable = (i: ItemListItem) => i.isSellable && i.price !== null;
  const add = (item: ItemListItem) => {
    props.onAdd(item);
    box.reset();
  };
  return (
    <div className={styles.picker} {...box.container}>
      <label className={styles.pickSearch}>
        <Search aria-hidden="true" />
        <input
          type="search"
          aria-label={t('lines.search')}
          placeholder={t('lines.search')}
          autoComplete="off"
          aria-expanded={box.open}
          {...box.input}
          onKeyDown={(event) => {
            scan.onKeyDown(event);
            // A scanned barcode or a full code adds the item at once.
            if (event.key !== 'Enter') return;
            event.preventDefault();
            // What is in the field now: a scanner's Enter can come before the screen catches up.
            const typed = scan.read(event.currentTarget.value.trim());
            const exact = choices.find(
              (c) =>
                sellable(c) &&
                (c.primaryBarcode === typed || c.code.toUpperCase() === typed.toUpperCase()),
            );
            const only = choices.filter(sellable);
            if (exact) add(exact);
            else if (box.q === typed && only.length === 1) add(only[0]!);
            else box.setQ(typed);
          }}
        />
      </label>
      {box.open && (
        <ul className={styles.choices} aria-label={t('lines.results')} ref={box.listRef}>
          {choices.map((choice) => (
            <li key={choice.id}>
              <button type="button" disabled={!sellable(choice)} onClick={() => add(choice)}>
                <Plus className={iconClass.sm} aria-hidden="true" />
                <span className={styles.choiceMain}>
                  <span>{name(choice)}</span>
                  <span className={styles.muted}>
                    <bdi>{choice.code}</bdi>
                    {!sellable(choice) && <> · {t('lines.notForSale')}</>}
                  </span>
                </span>
                {choice.price && <bdi>{price(BigInt(choice.price.price4dp))}</bdi>}
              </button>
            </li>
          ))}
          {found.isFetching && choices.length === 0 && (
            <li className={styles.muted}>{t('loading')}</li>
          )}
          {!found.isFetching && choices.length === 0 && (
            <li className={styles.muted}>{t('lines.none')}</li>
          )}
        </ul>
      )}
    </div>
  );
}

export function LineEditor(props: {
  lines: EditorLine[];
  onChange: (lines: EditorLine[]) => void;
  /** Quotations may mark lines optional: shown but not counted. */
  allowOptional?: boolean;
  /** The document discount as typed, so each line shows its share. */
  docDiscount?: string;
  /** Errors the server returned per line (line index → message). */
  lineErrors?: Record<number, string>;
}) {
  const { t, i18n } = useTranslation('sales');
  const refs = useLineRefs();
  const result = useLinesPreview(props.lines, props.docDiscount ?? '');
  const name = (l: EditorLine) => (i18n.language === 'ar' ? l.nameAr : l.nameEn);
  const update = (key: string, patch: Partial<EditorLine>) =>
    props.onChange(props.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <div className={styles.form}>
      <SellableItemPicker onAdd={(item) => props.onChange([...props.lines, lineFromItem(item)])} />
      {props.lines.length === 0 ? (
        <p className={styles.muted}>{t('lines.empty')}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={tbl.table} aria-label={t('lines.title')}>
            <thead>
              <tr>
                <th>{t('lines.item')}</th>
                <th className={tbl.num}>{t('lines.quantity')}</th>
                <th className={tbl.num}>{t('lines.unitPrice')}</th>
                <th className={tbl.num}>{t('lines.discount')}</th>
                <th className={tbl.num}>{t('lines.net')}</th>
                <th className={tbl.num}>{t('lines.vat')}</th>
                <th className={tbl.num}>{t('lines.lineTotal')}</th>
                {props.allowOptional && <th>{t('lines.optional')}</th>}
                <th>
                  <span className={styles.visuallyHidden}>{t('lines.remove', { name: '' })}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {props.lines.map((l, index) => {
                const read = readLine(l, refs.unitDecimalsOf(l.unitId));
                const problem = read.ok ? null : read.problem;
                const amounts = result.lines[index];
                const serverError = props.lineErrors?.[index];
                const changed = priceChanged(l);
                const rateBp = refs.rateOf(l.vatCategoryId);
                return (
                  <tr key={l.key} className={cx((problem || serverError) && styles.badRow)}>
                    <td>
                      <span>{name(l)}</span>
                      <span className={tbl.sub}>
                        <bdi>{l.code}</bdi>
                        {rateBp !== undefined && (
                          <>
                            {' '}
                            · {t('lines.vatRate')} <bdi>{rate(rateBp)}</bdi>
                          </>
                        )}
                      </span>
                      {serverError && <span className={styles.fieldError}>{serverError}</span>}
                    </td>
                    <td className={tbl.num}>
                      <div className={styles.inline}>
                        <input
                          className={cx(
                            styles.cellInput,
                            styles.narrow,
                            (problem === 'quantity' || problem === 'decimals') && styles.bad,
                          )}
                          inputMode="decimal"
                          aria-label={`${t('lines.quantity')} — ${name(l)}`}
                          value={l.quantity}
                          onChange={(e) => update(l.key, { quantity: e.target.value })}
                        />
                        <span className={styles.muted}>
                          {refs.unitName(l.unitId, i18n.language)}
                        </span>
                      </div>
                      {problem === 'decimals' && (
                        <span className={styles.fieldError}>{t('lines.unitDecimals')}</span>
                      )}
                    </td>
                    <td className={tbl.num}>
                      <input
                        className={cx(styles.cellInput, problem === 'price' && styles.bad)}
                        inputMode="decimal"
                        aria-label={`${t('lines.unitPrice')} — ${name(l)}`}
                        placeholder={price(BigInt(l.listPrice4dp))}
                        value={l.unitPrice}
                        onChange={(e) => update(l.key, { unitPrice: e.target.value })}
                      />
                      {changed && (
                        <span
                          className={cx(styles.muted, styles.changedPrice)}
                          title={t('lines.priceChanged')}
                        >
                          {t('lines.listPrice', { price: price(BigInt(l.listPrice4dp)) })}
                        </span>
                      )}
                    </td>
                    <td className={tbl.num}>
                      <div className={styles.inline}>
                        <input
                          className={cx(
                            styles.cellInput,
                            styles.narrow,
                            problem === 'discount' && styles.bad,
                          )}
                          inputMode="decimal"
                          aria-label={`${l.discountMode === 'percent' ? t('lines.discountPercent') : t('lines.discount')} — ${name(l)}`}
                          value={l.discount}
                          onChange={(e) => update(l.key, { discount: e.target.value })}
                        />
                        <button
                          type="button"
                          className={styles.discountMode}
                          aria-label={t('lines.discountMode')}
                          aria-pressed={l.discountMode === 'percent'}
                          onClick={() =>
                            update(l.key, {
                              discountMode: l.discountMode === 'percent' ? 'amount' : 'percent',
                              discount: '',
                            })
                          }
                        >
                          {l.discountMode === 'percent' ? '%' : t('lines.aed')}
                        </button>
                      </div>
                    </td>
                    <td className={tbl.num}>
                      {amounts ? <bdi>{money(amounts.netFils)}</bdi> : '—'}
                    </td>
                    <td className={tbl.num}>
                      {amounts ? <bdi>{money(amounts.vatFils)}</bdi> : '—'}
                    </td>
                    <td className={tbl.num}>
                      {amounts ? <bdi>{money(amounts.grossFils)}</bdi> : '—'}
                    </td>
                    {props.allowOptional && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${t('lines.optional')} — ${name(l)}`}
                          checked={l.optional}
                          onChange={(e) => update(l.key, { optional: e.target.checked })}
                        />
                      </td>
                    )}
                    <td>
                      <IconButton
                        aria-label={t('lines.remove', { name: name(l) })}
                        onPress={() => props.onChange(props.lines.filter((x) => x.key !== l.key))}
                      >
                        <Trash2 className={iconClass.sm} aria-hidden="true" />
                      </IconButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {props.lines.some(priceChanged) && <p className={styles.muted}>{t('lines.priceChanged')}</p>}
    </div>
  );
}

/** The totals box: a preview while editing, the server's figures for a saved document. */
export function TotalsBox(props: {
  rows: { label: string; fils: bigint; strong?: boolean }[];
  note?: string;
}) {
  return (
    <div className={styles.form}>
      <dl className={styles.totals}>
        {props.rows.map((r) => (
          <div key={r.label} className={cx(r.strong && styles.strong)}>
            <dt>{r.label}</dt>
            <dd>
              <bdi>{money(r.fils)}</bdi>
            </dd>
          </div>
        ))}
      </dl>
      {props.note && <p className={styles.muted}>{props.note}</p>}
    </div>
  );
}

/** The preview totals for an editor: subtotal, discounts, taxable amount, VAT and total. */
export function PreviewTotals(props: { preview: Preview }) {
  const { t } = useTranslation('sales');
  const p = props.preview;
  return (
    <TotalsBox
      rows={[
        { label: t('totals.subtotal'), fils: p.subtotalFils },
        ...(p.discountFils > 0n ? [{ label: t('totals.discount'), fils: p.discountFils }] : []),
        { label: t('totals.net'), fils: p.netFils },
        { label: t('totals.vat'), fils: p.vatFils },
        { label: t('totals.total'), fils: p.totalFils, strong: true },
      ]}
      note={t('totals.preview')}
    />
  );
}
