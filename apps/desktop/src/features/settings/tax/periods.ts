/** Accounting months as people read them, and which step each one may take (decision 0016). */
import type { PeriodItem } from '@artepool/shared/contracts';

/** "أكتوبر 2026" / "October 2026": the month's name in the screen's language, Western digits. */
export function monthName(periodStart: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Dubai',
    numberingSystem: 'latn',
  }).format(new Date(`${periodStart}T00:00:00Z`));
}

/** A month can be closed only after its last day (`today` is the server's day in Al Ain). */
export const hasEnded = (period: PeriodItem, today: string): boolean => period.periodEnd < today;

/** How many months the card shows before "Show all". */
export const RECENT_MONTHS = 15;
