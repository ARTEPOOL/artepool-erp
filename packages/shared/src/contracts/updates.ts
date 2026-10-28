/** Automatic online updates in System health (decision 0108): owner only. */
import { z } from 'zod';

export const UPDATE_WAITING_REASONS = [
  'open_shift',
  'outside_window',
  'failed_before',
  'installing',
] as const;
export type UpdateWaitingReason = (typeof UPDATE_WAITING_REASONS)[number];

/** x.y.z versions: true when `a` is newer than `b` (anything that is not x.y.z is never newer). */
export function isNewerVersion(a: string, b: string | null): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
  const x = parse(a);
  if (!x) return false;
  const y = b ? parse(b) : undefined;
  if (!y) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

export interface UpdateResult {
  ok: boolean;
  from: string | null;
  to: string | null;
  at: string;
  /** The step that failed (checks, open_shift, backup, migrate, health, put_back, services). */
  step?: string;
  /** The previous version is running again (a failed update is always rolled back). */
  databasePutBack?: boolean;
}

export interface UpdateStatus {
  currentVersion: string | null;
  checkedAt: string | null;
  /** Why the update list could not be read (no internet is normal; updates wait). */
  checkError: string | null;
  /** The owner pressed "Check now" (0110) and the server PC has not read the list since. */
  checking: boolean;
  /** Only a version newer than the one running (the one just installed is never "new"). */
  available: {
    version: string;
    notesAr: string | null;
    notesEn: string | null;
    publishedAt: string | null;
  } | null;
  downloadStatus: 'none' | 'downloading' | 'ready' | 'failed';
  waitingReason: UpdateWaitingReason | null;
  lastResult: UpdateResult | null;
  window: { startHour: number; endHour: number };
  /** The owner's latest "Install now". */
  request: { version: string; status: 'pending' | 'running' | 'done' | 'failed' } | null;
}

export const UpdateWindowBody = z
  .object({
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(0).max(23),
  })
  .strict()
  .refine((b) => b.startHour !== b.endHour, { path: ['endHour'] });
export type UpdateWindowBody = z.infer<typeof UpdateWindowBody>;
