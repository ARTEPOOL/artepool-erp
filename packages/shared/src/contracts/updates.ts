/** Automatic online updates in System health (decision 0108): owner only. */
import { z } from 'zod';

export const UPDATE_WAITING_REASONS = [
  'open_shift',
  'outside_window',
  'failed_before',
  'installing',
] as const;
export type UpdateWaitingReason = (typeof UPDATE_WAITING_REASONS)[number];

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
