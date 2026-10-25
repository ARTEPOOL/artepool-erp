/**
 * The cash count by note and coin, plus an "other amount" (decision 0056), exact to the fils.
 * Used to close a shift at the POS and to close a stuck shift from another PC (decision 0069).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyFormatError, parseFils } from '@artepool/shared';
import type { CountLines, PosState } from '@artepool/shared/contracts';
import { cx, TextField } from '../../../ui';
import { money } from '../../masterdata/format';
import styles from '../pos.module.css';

type Denomination = PosState['denominations'][number];

const readCount = (text: string): number | null =>
  text.trim() === '' ? 0 : /^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : null;

export function useCountForm(denominations: Denomination[]) {
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [other, setOther] = useState('');
  const otherFils = (() => {
    try {
      return other.trim() === '' ? 0n : parseFils(other.trim());
    } catch (e) {
      if (e instanceof MoneyFormatError) return null;
      throw e;
    }
  })();
  const total = denominations.reduce((sum, d) => {
    const n = readCount(counts[d.id] ?? '');
    return n === null ? sum : sum + BigInt(d.valueFils) * BigInt(n);
  }, otherFils ?? 0n);
  const invalid =
    otherFils === null ||
    otherFils < 0n ||
    denominations.some((d) => readCount(counts[d.id] ?? '') === null);
  return {
    denominations,
    counts,
    setCounts,
    other,
    setOther,
    total,
    invalid,
    reset: () => {
      setCounts({});
      setOther('');
    },
    /** The count as the server takes it. */
    body: (): CountLines => ({
      lines: denominations
        .map((d) => ({ denominationId: d.id, quantity: readCount(counts[d.id] ?? '') ?? 0 }))
        .filter((l) => l.quantity > 0),
      otherAmountFils: (otherFils ?? 0n).toString(),
    }),
  };
}

export type CountForm = ReturnType<typeof useCountForm>;

export function CountFields({ form }: { form: CountForm }) {
  const { t } = useTranslation('pos');
  return (
    <>
      <div className={styles.countGrid}>
        {(['note', 'coin'] as const).map((kind) => (
          <div key={kind} className={styles.countGroup}>
            <h3>{t(`closeShift.${kind}s`)}</h3>
            {form.denominations
              .filter((d) => d.kind === kind)
              .map((d) => {
                const n = readCount(form.counts[d.id] ?? '');
                return (
                  <div key={d.id} className={styles.countRow}>
                    <bdi className={styles.countValue}>{money(BigInt(d.valueFils))}</bdi>
                    <input
                      className={cx(styles.qtyInput, n === null && styles.bad)}
                      inputMode="numeric"
                      aria-label={t('closeShift.countOf', {
                        value: money(BigInt(d.valueFils)),
                      })}
                      value={form.counts[d.id] ?? ''}
                      onChange={(e) => form.setCounts({ ...form.counts, [d.id]: e.target.value })}
                    />
                    <bdi className={styles.countAmount}>
                      {n === null ? '—' : money(BigInt(d.valueFils) * BigInt(n))}
                    </bdi>
                  </div>
                );
              })}
          </div>
        ))}
      </div>
      <TextField
        label={t('closeShift.other')}
        value={form.other}
        onChange={form.setOther}
        inputMode="decimal"
        ltr
        hint={t('closeShift.otherHint')}
      />
      <div className={styles.change}>
        <span>{t('closeShift.counted')}</span>
        <b data-testid="count-total">
          <bdi>{money(form.total)}</bdi>
        </b>
      </div>
    </>
  );
}
