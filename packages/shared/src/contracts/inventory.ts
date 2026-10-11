/**
 * Stock (M3): balances, adjustments (ADJ-), counts (CNT-), oversell reviews and the journal.
 * Quantities travel as thousandths and values as fils or 4-decimal units, all whole-number text.
 * Values are present only for someone with `stock.view_cost` (decision 0040).
 */
import { z } from 'zod';
import { IdText } from './auth';
import { NonNegativeIntText, OptionalText, RowVersion } from './common';

export const DateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const STOCK_STATUSES = ['available', 'defective'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

// ---------------------------------------------------------------------------------------------
// Balances and movements
// ---------------------------------------------------------------------------------------------

export interface StockBalance {
  warehouseId: string;
  stockStatus: StockStatus;
  quantityMilli: string;
  /** Value at average cost (4 decimals) and its book amount; with stock.view_cost only. */
  value4dp?: string;
  bookValueFils?: string;
  avgUnitCost4dp?: string | null;
}

export const MOVEMENT_TYPES = [
  'opening',
  'sale',
  'sale_return',
  'adjustment_in',
  'adjustment_out',
  'oversell_in',
  'status_out',
  'status_in',
  'write_off',
  'count_gain',
  'count_loss',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export interface StockMovement {
  id: string;
  movementType: MovementType;
  occurredAt: string;
  movementDate: string;
  warehouseId: string;
  stockStatus: StockStatus;
  /** Signed thousandths. */
  quantityMilli: string;
  qtyAfterMilli: string;
  /** The document that moved the stock (ADJ-…, CNT-…). */
  documentNumber: string | null;
  documentId: string | null;
  documentKind: 'adjustment' | 'count' | 'sale' | null;
  reasonCodeId: string | null;
  /** Signed values; with stock.view_cost only. */
  value4dp?: string;
  valueFils?: string;
}

export interface ItemStockResponse {
  balances: StockBalance[];
  movements: StockMovement[];
  totalMovements: number;
}

export const ItemStockQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** The stock tiles of design 07. */
export interface StockSummary {
  /** Book value of all stock (sellable + defective); with stock.view_cost only. */
  valueFils?: string;
  toReorder: number;
  defectiveItems: number;
  pendingReviews: number;
}

// ---------------------------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------------------------

export const ADJUSTMENT_KINDS = [
  'opening',
  'increase',
  'decrease',
  'status_change',
  'write_off',
] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number] | 'oversell';

/** The permission each kind of adjustment needs (decisions 0015, 0042). */
export const ADJUSTMENT_PERMISSION: Record<(typeof ADJUSTMENT_KINDS)[number], string> = {
  opening: 'stock.opening',
  increase: 'stock.adjust',
  decrease: 'stock.adjust',
  status_change: 'stock.defective',
  write_off: 'stock.write_off',
};

const PositiveMilli = z.string().regex(/^[1-9][0-9]{0,17}$/);

export const CreateAdjustmentRequest = z.object({
  kind: z.enum(ADJUSTMENT_KINDS),
  warehouseId: IdText.optional(),
  /** Defaults to today (Al Ain); must be in an open month. */
  date: DateText.optional(),
  reasonCodeId: IdText,
  note: OptionalText(1000),
  /** A supervisor's approval when the value is above the threshold (decision 0041). */
  approvalId: IdText.optional(),
  lines: z
    .array(
      z.object({
        itemId: IdText,
        quantityMilli: PositiveMilli,
        /**
         * Incoming stock only. Without it: the current average, then the last average, then the
         * item's purchase price. Only someone with stock.view_cost may type it.
         */
        unitCost4dp: NonNegativeIntText.optional(),
        /** Status changes: from where to where (to defective by default). */
        stockStatus: z.enum(STOCK_STATUSES).optional(),
        targetStatus: z.enum(STOCK_STATUSES).optional(),
        note: OptionalText(500),
      }),
    )
    .min(1)
    .max(500),
});
export type CreateAdjustmentRequest = z.infer<typeof CreateAdjustmentRequest>;

export interface AdjustmentLine {
  lineNo: number;
  itemId: string;
  itemCode: string;
  nameAr: string;
  nameEn: string;
  unitId: string;
  stockStatus: StockStatus;
  targetStatus: StockStatus | null;
  quantityMilli: string;
  note: string | null;
  /** With stock.view_cost only. */
  unitCost4dp?: string | null;
  valueFils?: string | null;
}

export interface AdjustmentItem {
  id: string;
  docNumber: string | null;
  kind: AdjustmentKind;
  status: 'draft' | 'posted' | 'cancelled';
  warehouseId: string;
  date: string;
  reasonCodeId: string;
  note: string | null;
  reviewStatus: 'not_required' | 'pending' | 'reviewed';
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  postedAt: string | null;
  postedBy: string | null;
  lineCount: number;
  /** Signed book value; with stock.view_cost only. */
  totalValueFils?: string | null;
  journalEntryId: string | null;
  rowVersion: number;
}

export interface AdjustmentDetail extends AdjustmentItem {
  lines: AdjustmentLine[];
  journalEntryNumber: string | null;
}

export const AdjustmentsQuery = z.object({
  kind: z.enum([...ADJUSTMENT_KINDS, 'oversell']).optional(),
  review: z.enum(['pending', 'reviewed']).optional(),
  itemId: IdText.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdjustmentsQuery = z.infer<typeof AdjustmentsQuery>;

export interface AdjustmentsResponse {
  adjustments: AdjustmentItem[];
  total: number;
}

export const ReviewOversellRequest = z.object({
  note: z.string().trim().min(3).max(1000),
  rowVersion: RowVersion,
});
export type ReviewOversellRequest = z.infer<typeof ReviewOversellRequest>;

// ---------------------------------------------------------------------------------------------
// Counts (blind while counting — decision 0044)
// ---------------------------------------------------------------------------------------------

export const CreateCountRequest = z
  .object({
    warehouseId: IdText.optional(),
    scope: z.enum(['full', 'category', 'selected']),
    categoryId: IdText.optional(),
    itemIds: z.array(IdText).max(2000).optional(),
    note: OptionalText(1000),
  })
  .refine((r) => (r.scope === 'category') === (r.categoryId !== undefined), {
    path: ['categoryId'],
  })
  .refine((r) => r.scope !== 'selected' || (r.itemIds?.length ?? 0) > 0, { path: ['itemIds'] });
export type CreateCountRequest = z.infer<typeof CreateCountRequest>;

export interface CountLine {
  id: string;
  itemId: string;
  itemCode: string;
  nameAr: string;
  nameEn: string;
  unitId: string;
  stockStatus: StockStatus;
  countedMilli: string | null;
  countedBy: string | null;
  countedAt: string | null;
  reasonCodeId: string | null;
  note: string | null;
  /** Shown only on the review step, to someone with stock.count_post (blind counts). */
  systemMilli?: string;
  movedSinceMilli?: string;
  varianceMilli?: string;
  /** With stock.view_cost only. */
  varianceFils?: string;
}

export interface CountItem {
  id: string;
  docNumber: string | null;
  status: 'draft' | 'counting' | 'posted' | 'cancelled';
  scope: 'full' | 'category' | 'selected';
  categoryId: string | null;
  warehouseId: string;
  snapshotAt: string | null;
  countDate: string | null;
  note: string | null;
  lineCount: number;
  countedLines: number;
  postedAt: string | null;
  createdAt: string;
  /** With stock.view_cost only. */
  totalValueFils?: string | null;
  rowVersion: number;
}

export interface CountDetail extends CountItem {
  lines: CountLine[];
  /** True when the review numbers are included (stock.count_post). */
  review: boolean;
}

export interface CountsResponse {
  counts: CountItem[];
  total: number;
}

export const SaveCountLinesRequest = z.object({
  lines: z
    .array(z.object({ lineId: IdText, countedMilli: NonNegativeIntText.nullable() }))
    .min(1)
    .max(2000),
});
export type SaveCountLinesRequest = z.infer<typeof SaveCountLinesRequest>;

export const PostCountRequest = z.object({
  /** A reason (and note) for every line with a difference. */
  reasons: z
    .array(z.object({ lineId: IdText, reasonCodeId: IdText, note: OptionalText(500) }))
    .max(2000)
    .default([]),
  date: DateText.optional(),
  approvalId: IdText.optional(),
  rowVersion: RowVersion,
});
export type PostCountRequest = z.infer<typeof PostCountRequest>;

// ---------------------------------------------------------------------------------------------
// Journal (ledger.view)
// ---------------------------------------------------------------------------------------------

export const JOURNAL_SOURCES = [
  'sales_document',
  'payment',
  'opening_balance',
  'cash_movement',
  'shift_close',
  'inventory_adjustment',
  'inventory_count',
  'reversal',
  'manual',
] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

export const JournalQuery = z.object({
  from: DateText.optional(),
  to: DateText.optional(),
  source: z.enum(JOURNAL_SOURCES).optional(),
  accountId: IdText.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type JournalQuery = z.infer<typeof JournalQuery>;

export interface JournalEntryItem {
  id: string;
  entryNumber: string;
  entryDate: string;
  sourceType: JournalSource;
  /** The document's number and id (ADJ-…, CNT-…). */
  sourceNumber: string | null;
  sourceId: string | null;
  memo: string | null;
  totalFils: string;
  postedAt: string;
  postedBy: string;
}

export interface JournalLine {
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountNameAr: string;
  accountNameEn: string;
  debitFils: string;
  creditFils: string;
  customerId: string | null;
  businessLineId: string | null;
  memo: string | null;
}

export interface JournalEntryDetail extends JournalEntryItem {
  lines: JournalLine[];
}

export interface JournalResponse {
  entries: JournalEntryItem[];
  total: number;
}

export const TrialBalanceQuery = z.object({ from: DateText, to: DateText });
export type TrialBalanceQuery = z.infer<typeof TrialBalanceQuery>;

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  accountType: string;
  debitFils: string;
  creditFils: string;
  /** Debit − credit over the range. */
  balanceFils: string;
}

export interface TrialBalanceResponse {
  rows: TrialBalanceRow[];
  totalDebitFils: string;
  totalCreditFils: string;
}

// ---------------------------------------------------------------------------------------------
// Barcode label sizes (decision 0043)
// ---------------------------------------------------------------------------------------------

export interface LabelSizeItem {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  widthMm: number;
  heightMm: number;
  sortOrder: number;
  isActive: boolean;
  rowVersion: number;
}

const LabelSizeFields = z.object({
  nameAr: z.string().trim().min(1).max(100),
  nameEn: z.string().trim().min(1).max(100),
  widthMm: z.number().int().min(10).max(210),
  heightMm: z.number().int().min(10).max(297),
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export const CreateLabelSizeRequest = LabelSizeFields.extend({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,32}$/),
});
export type CreateLabelSizeRequest = z.infer<typeof CreateLabelSizeRequest>;
export const UpdateLabelSizeRequest = LabelSizeFields.extend({ rowVersion: RowVersion });
export type UpdateLabelSizeRequest = z.infer<typeof UpdateLabelSizeRequest>;
