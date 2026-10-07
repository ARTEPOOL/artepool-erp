const dubaiDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dubai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The business date in Al Ain (YYYY-MM-DD) for a moment in time. Matches sys.business_date. */
export function dubaiDate(at: Date): string {
  return dubaiDay.format(at);
}

/** How far a PC's clock is from the server clock, in whole seconds (positive = PC is ahead). */
export function clockSkewSeconds(clientTime: Date, serverTime: Date): number {
  return Math.round((clientTime.getTime() - serverTime.getTime()) / 1000);
}
