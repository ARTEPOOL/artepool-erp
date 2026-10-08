/** Building blocks shared by the master-data contracts (M2). */
import { z } from 'zod';
import { CODE_PATTERN } from '../masterdata';

/**
 * The version of a record the screen started from ("changed by someone else"): every edit sends
 * it back, and the server refuses the save with STALE_VERSION if someone saved in between.
 */
export const RowVersion = z.number().int().positive();

/** Whole numbers sent as exact text: amounts in fils, prices in 4 decimals, quantities in thousandths. */
export const IntText = z.string().regex(/^-?(0|[1-9][0-9]{0,17})$/);
export const NonNegativeIntText = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);

/** A code as typed; item, customer and supplier codes are stored in capitals by the server. */
export const Code = z.string().trim().regex(CODE_PATTERN);

export const Name = z.string().trim().min(1).max(200);

/** Optional free text: empty means none. */
export const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

/** A written reason (deactivation, credit, VAT rate, reopening a month): stored in the audit log. */
export const Reason = z.string().trim().min(3).max(500);

export const DeactivateRequest = z.object({ reason: Reason, rowVersion: RowVersion });
export type DeactivateRequest = z.infer<typeof DeactivateRequest>;

export const ReactivateRequest = z.object({ rowVersion: RowVersion });
export type ReactivateRequest = z.infer<typeof ReactivateRequest>;

export const EMIRATES = [
  'abu_dhabi',
  'dubai',
  'sharjah',
  'ajman',
  'umm_al_quwain',
  'ras_al_khaimah',
  'fujairah',
] as const;
export type Emirate = (typeof EMIRATES)[number];

/** Which records a list shows. */
export const ActiveFilter = z.enum(['active', 'inactive', 'all']).default('active');
export type ActiveFilter = z.infer<typeof ActiveFilter>;

/** Search and paging for the long lists (items, customers, suppliers). */
export const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: ActiveFilter,
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListQuery = z.infer<typeof ListQuery>;

/** Bilingual reference to another record, enough to show it in a list. */
export interface NamedRef {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
}

/** A file sent inside JSON (Excel templates and exports, the company logo). */
export interface FilePayload {
  fileName: string;
  mime: string;
  dataBase64: string;
}
