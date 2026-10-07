/**
 * Dates and times as people read them: Al Ain time (Asia/Dubai), Western digits, 24-hour
 * clock, day/month/year — in both languages, like the design. The server stores UTC only.
 */
const TIME_ZONE = 'Asia/Dubai';

const time = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const date = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const day = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export const formatTime = (iso: string): string => time.format(new Date(iso));
export const formatDate = (iso: string): string => date.format(new Date(iso));
export const formatDateTime = (iso: string): string => `${formatDate(iso)} ${formatTime(iso)}`;

/** The Al Ain calendar day of a moment, as `YYYY-MM-DD`. */
export const dubaiDay = (at: Date | string = new Date()): string =>
  day.format(typeof at === 'string' ? new Date(at) : at);

/** `YYYY-MM-DD` plus or minus whole days (calendar arithmetic, no time zone involved). */
export function addDays(isoDay: string, days: number): string {
  const [y, m, d] = isoDay.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
