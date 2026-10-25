/**
 * Which copies to remove (decision 0086). Local: every copy of the last `hourly` hours (one an
 * hour), plus the first copy of each of the last `daily` days. Off-site: the first copy of each
 * of the last `daily` days and of each of the last `monthly` months. Everything older goes.
 * Copies are named `artepool-YYYYMMDD-HHMMSSZ.dump` (`.dump.age` off-site, UTC), so the name
 * gives the time.
 */
const NAME = /^artepool-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})Z\.dump(\.age)?$/;

export function backupFileName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `artepool-${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-` +
    `${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}Z.dump`
  );
}

export function timeOf(name: string): Date | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.slice(0, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

export function filesToRemove(
  names: string[],
  now: Date,
  keep: { hourly: number; daily: number; monthly?: number },
): string[] {
  const copies = names
    .map((name) => ({ name, at: timeOf(name) }))
    .filter((c): c is { name: string; at: Date } => c.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const oldestHour = now.getTime() - keep.hourly * 3600 * 1000;
  const kept = new Set(copies.filter((c) => c.at.getTime() >= oldestHour).map((c) => c.name));
  const oldestDay = now.getTime() - keep.daily * 24 * 3600 * 1000;
  const firstOfDay = new Map<string, string>();
  for (const c of copies) {
    if (c.at.getTime() < oldestDay) continue;
    // Walking newest → oldest, the last one seen for a day is that day's first copy.
    firstOfDay.set(c.at.toISOString().slice(0, 10), c.name);
  }
  for (const name of firstOfDay.values()) kept.add(name);
  if (keep.monthly) {
    const oldestMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - keep.monthly + 1, 1),
    );
    const firstOfMonth = new Map<string, string>();
    for (const c of copies) {
      if (c.at < oldestMonth) continue;
      firstOfMonth.set(c.at.toISOString().slice(0, 7), c.name);
    }
    for (const name of firstOfMonth.values()) kept.add(name);
  }
  return copies.filter((c) => !kept.has(c.name)).map((c) => c.name);
}
