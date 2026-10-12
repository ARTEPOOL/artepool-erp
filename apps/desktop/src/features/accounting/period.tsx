/**
 * The date range of the journal and the trial balance: Al Ain calendar days (`YYYY-MM-DD`),
 * this month by default. The server checks the dates again.
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { addDays, dubaiDay } from '../../lib/format';
import { FieldMessage } from '../settings/lists/parts';
import styles from './accounting.module.css';

export interface DateRange {
  from: string;
  to: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The first and the last day of the month that contains `today` (Al Ain time). */
export function thisMonth(today: string = dubaiDay()): DateRange {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const from = `${today.slice(0, 7)}-01`;
  const next =
    month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return { from, to: addDays(next, -1) };
}

/** Both days are filled in and the first is not after the second. */
export const isValidRange = (range: DateRange): boolean =>
  DAY.test(range.from) && DAY.test(range.to) && range.from <= range.to;

/** Two date fields side by side, with the message when the range is not usable. */
export function DateRangeFields(props: { value: DateRange; onChange: (value: DateRange) => void }) {
  const { t } = useTranslation('accounting');
  const id = useId();
  const { value } = props;
  return (
    <>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-from`}>
          {t('period.from')}
        </label>
        <input
          id={`${id}-from`}
          type="date"
          className={styles.dateInput}
          value={value.from}
          max={value.to || undefined}
          onChange={(event) => props.onChange({ ...value, from: event.target.value })}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-to`}>
          {t('period.to')}
        </label>
        <input
          id={`${id}-to`}
          type="date"
          className={styles.dateInput}
          value={value.to}
          min={value.from || undefined}
          onChange={(event) => props.onChange({ ...value, to: event.target.value })}
        />
      </div>
      {!isValidRange(value) && (
        <div className={styles.rangeError}>
          <FieldMessage text={t('period.invalid')} />
        </div>
      )}
    </>
  );
}
