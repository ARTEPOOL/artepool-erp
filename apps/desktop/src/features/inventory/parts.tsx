/**
 * Small pieces shared by the stock pages: reading typed quantities and costs (never floats),
 * the "someone else changed it" message, status chips and the stock item picker.
 */
import { useEffect, useState } from 'react';
import { Ban, CheckCircle2, ClipboardList, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  fitsUnitDecimals,
  formatQuantity,
  MoneyFormatError,
  parse4dp,
  parseQuantity,
} from '@artepool/shared';
import type { CountItem, ItemListItem, UnitItem } from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { Alert, Button, Chip, iconClass } from '../../ui';
import { useErrorText } from '../auth/context';
import { localName } from '../masterdata/refs';
import { useStockItemSearch } from './api';
import styles from './inventory.module.css';

export type QuantityProblem = 'invalid' | 'decimals' | 'zero';
export type Read<T> = { ok: true; value: T } | { ok: false; problem: QuantityProblem };

/**
 * A typed quantity → thousandths. Arabic digits are accepted; the unit's decimals are checked
 * (pieces: whole numbers only). `allowZero` for counts, where zero is a real answer.
 */
export function readQuantity(text: string, decimals: number, allowZero: boolean): Read<bigint> {
  let milli: bigint;
  try {
    milli = parseQuantity(text.trim());
  } catch (error) {
    if (error instanceof MoneyFormatError) return { ok: false, problem: 'invalid' };
    throw error;
  }
  if (milli < 0n) return { ok: false, problem: 'invalid' };
  if (milli === 0n && !allowZero) return { ok: false, problem: 'zero' };
  if (!fitsUnitDecimals(milli, decimals)) return { ok: false, problem: 'decimals' };
  return { ok: true, value: milli };
}

/** A typed unit cost (4 decimals, not negative) → its 4-decimal integer; empty → null. */
export function readCost(text: string): Read<bigint | null> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };
  try {
    const value = parse4dp(trimmed);
    return value < 0n ? { ok: false, problem: 'invalid' } : { ok: true, value };
  } catch (error) {
    if (error instanceof MoneyFormatError) return { ok: false, problem: 'invalid' };
    throw error;
  }
}

/** Thousandths → text without trailing zeros ("10", "1.5"); a sign for differences. */
export function quantityShort(milli: bigint, signed = false): string {
  const text = formatQuantity(milli).replace(/\.?0+$/, '') || '0';
  return signed && milli > 0n ? `+${text}` : text;
}

export const isStale = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'STALE_VERSION';

export const ruleOf = (error: unknown): string | undefined => {
  const rule = error instanceof ApiError ? error.details.rule : undefined;
  return typeof rule === 'string' ? rule : undefined;
};

/** A refused save: "changed by someone else" with Reload, or the translated error. */
export function SaveError({ error, onReload }: { error: unknown; onReload?: () => void }) {
  const { t } = useTranslation('masterdata');
  const errorText = useErrorText();
  if (error === null || error === undefined) return null;
  if (isStale(error)) {
    return (
      <Alert tone="warn">
        <span>{t('stale')}</span>
        {onReload && (
          <Button variant="ghost" onPress={onReload}>
            {t('actions.reload')}
          </Button>
        )}
      </Alert>
    );
  }
  return <Alert>{errorText(error)}</Alert>;
}

/** The unit's name and decimals for an item row. */
export function useUnitOf(units: UnitItem[] | undefined) {
  const { i18n } = useTranslation();
  const name = localName(i18n.language);
  return (unitId: string) => {
    const unit = units?.find((u) => u.id === unitId);
    return { name: unit ? name(unit) : '', decimals: unit?.decimals ?? 0 };
  };
}

/** Status = text + icon + colour. */
export function CountStatusChip({ status }: { status: CountItem['status'] }) {
  const { t } = useTranslation('inventory');
  if (status === 'posted') {
    return (
      <Chip tone="ok" icon={<CheckCircle2 aria-hidden="true" />}>
        {t('counts.status.posted')}
      </Chip>
    );
  }
  if (status === 'cancelled') {
    return <Chip icon={<Ban aria-hidden="true" />}>{t('counts.status.cancelled')}</Chip>;
  }
  return (
    <Chip tone="info" icon={<ClipboardList aria-hidden="true" />}>
      {t('counts.status.counting')}
    </Chip>
  );
}

/**
 * Search for active stock items and add one (services and kits hold no stock). Items already
 * chosen are left out of the results.
 */
export function StockItemPicker(props: {
  taken: ReadonlySet<string>;
  onAdd: (item: ItemListItem) => void;
}) {
  const { t, i18n } = useTranslation('inventory');
  const name = localName(i18n.language);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const found = useStockItemSearch(q);
  const choices = (found.data?.items ?? []).filter(
    (i) => i.itemType === 'stock' && !props.taken.has(i.id),
  );
  return (
    <div className={styles.picker}>
      <label className={styles.pickSearch}>
        <Search aria-hidden="true" />
        <input
          type="search"
          aria-label={t('picker.search')}
          placeholder={t('picker.search')}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      {q && (
        <ul className={styles.choices} aria-label={t('picker.results')}>
          {choices.map((choice) => (
            <li key={choice.id}>
              <button
                type="button"
                onClick={() => {
                  props.onAdd(choice);
                  setText('');
                  setQ('');
                }}
              >
                <Plus className={iconClass.sm} aria-hidden="true" />
                <span>{name(choice)}</span>
                <bdi className={styles.muted}>{choice.code}</bdi>
              </button>
            </li>
          ))}
          {!found.isFetching && choices.length === 0 && (
            <li className={styles.muted}>{t('picker.none')}</li>
          )}
        </ul>
      )}
    </div>
  );
}
