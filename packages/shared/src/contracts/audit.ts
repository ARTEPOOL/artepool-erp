/** Settings → Audit log (read only). */
import { z } from 'zod';

export const AUDIT_KINDS = ['security', 'settings', 'data'] as const;

export const AuditQuery = z.object({
  /** Entries before this id (newest first, for "load more"). */
  before: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  userId: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .optional(),
  /** Al Ain calendar dates, inclusive. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  kind: z.enum(AUDIT_KINDS).optional(),
  q: z.string().trim().max(100).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export interface AuditEntry {
  id: string;
  seq: string | null;
  /** Server time (UTC, ISO). */
  at: string;
  /** `insert`, `update`, `delete` or `event:<name>`. */
  action: string;
  entityType: string | null;
  entityId: string | null;
  /** Name of the record when it is a user or device, for display. */
  entityLabel: string | null;
  user: { id: string; username: string; displayNameAr: string; displayNameEn: string } | null;
  device: { id: string; code: string } | null;
  reason: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Pass as `before` to load older entries; null at the start of the log. */
  nextBefore: string | null;
}

export interface ChainStatus {
  lastSeq: string;
  fingerprint: string;
  lastCheck: { at: string; ok: boolean; rowsChecked: string; firstBadSeq: string | null } | null;
}
