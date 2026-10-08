/**
 * Settings → Lists (decision 0034): technicians, payment methods, warehouses and reason codes;
 * and Settings → VAT & numbering: the numbering series (decision 0011).
 */
import { z } from 'zod';
import { IdText } from './auth';
import { Code, Name, OptionalText, RowVersion } from './common';

// ---------------------------------------------------------------------------------------------
// Technicians
// ---------------------------------------------------------------------------------------------

export interface TechnicianItem {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  phone: string | null;
  userId: string | null;
  isActive: boolean;
  rowVersion: number;
}

const TechnicianFields = z.object({
  code: Code,
  nameAr: Name,
  nameEn: Name,
  phone: OptionalText(40),
  userId: IdText.nullable().default(null),
});
export const CreateTechnicianRequest = TechnicianFields;
export type CreateTechnicianRequest = z.infer<typeof CreateTechnicianRequest>;
export const UpdateTechnicianRequest = TechnicianFields.extend({ rowVersion: RowVersion });
export type UpdateTechnicianRequest = z.infer<typeof UpdateTechnicianRequest>;

// ---------------------------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------------------------

export const PAYMENT_KINDS = ['cash', 'card', 'bank_transfer', 'cheque', 'other'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export interface PaymentMethodItem {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  kind: PaymentKind;
  glAccountId: string;
  opensDrawer: boolean;
  givesChange: boolean;
  requiresReference: boolean;
  inPos: boolean;
  inOffice: boolean;
  sortOrder: number;
  isActive: boolean;
  rowVersion: number;
}

const PaymentMethodFields = z.object({
  nameAr: Name,
  nameEn: Name,
  glAccountId: IdText,
  opensDrawer: z.boolean(),
  givesChange: z.boolean(),
  requiresReference: z.boolean(),
  inPos: z.boolean(),
  inOffice: z.boolean(),
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export const CreatePaymentMethodRequest = PaymentMethodFields.extend({
  code: Code,
  kind: z.enum(PAYMENT_KINDS),
});
export type CreatePaymentMethodRequest = z.infer<typeof CreatePaymentMethodRequest>;
export const UpdatePaymentMethodRequest = PaymentMethodFields.extend({ rowVersion: RowVersion });
export type UpdatePaymentMethodRequest = z.infer<typeof UpdatePaymentMethodRequest>;

// ---------------------------------------------------------------------------------------------
// Warehouses (one now; the screens hide the choice while only one exists)
// ---------------------------------------------------------------------------------------------

export const WAREHOUSE_TYPES = ['store', 'site', 'van'] as const;
export type WarehouseType = (typeof WAREHOUSE_TYPES)[number];

export interface WarehouseItem {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  warehouseType: WarehouseType;
  technicianId: string | null;
  isDefault: boolean;
  isActive: boolean;
  rowVersion: number;
}

const WarehouseFields = z.object({
  nameAr: Name,
  nameEn: Name,
  warehouseType: z.enum(WAREHOUSE_TYPES),
  technicianId: IdText.nullable().default(null),
});
export const CreateWarehouseRequest = WarehouseFields.extend({ code: Code });
export type CreateWarehouseRequest = z.infer<typeof CreateWarehouseRequest>;
export const UpdateWarehouseRequest = WarehouseFields.extend({ rowVersion: RowVersion });
export type UpdateWarehouseRequest = z.infer<typeof UpdateWarehouseRequest>;

// ---------------------------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------------------------

export const REASON_CATEGORIES = [
  'stock_increase',
  'stock_decrease',
  'stock_count',
  'defective',
  'write_off',
  'oversell',
  'credit_note',
  'debit_note',
  'payment_reversal',
  'price_override',
  'discount_override',
  'no_sale',
  'paid_in',
  'paid_out',
  'cash_recount',
  'cash_variance',
  'draft_discard',
  'reprint',
  'other',
] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];
/** Reasons that post money to an account (posting map rows 16–17). */
export const REASON_CATEGORIES_WITH_ACCOUNT: readonly ReasonCategory[] = ['paid_in', 'paid_out'];

export interface ReasonCodeItem {
  id: string;
  category: ReasonCategory;
  code: string;
  nameAr: string;
  nameEn: string;
  requiresNote: boolean;
  glAccountId: string | null;
  isActive: boolean;
  rowVersion: number;
}

const ReasonCodeFields = z.object({
  nameAr: Name,
  nameEn: Name,
  requiresNote: z.boolean().default(false),
  glAccountId: IdText.nullable().default(null),
});
export const CreateReasonCodeRequest = ReasonCodeFields.extend({
  category: z.enum(REASON_CATEGORIES),
  code: Code,
});
export type CreateReasonCodeRequest = z.infer<typeof CreateReasonCodeRequest>;
export const UpdateReasonCodeRequest = ReasonCodeFields.extend({ rowVersion: RowVersion });
export type UpdateReasonCodeRequest = z.infer<typeof UpdateReasonCodeRequest>;

// ---------------------------------------------------------------------------------------------
// Numbering series (gapless; decision 0011)
// ---------------------------------------------------------------------------------------------

export interface SeriesItem {
  id: string;
  code: string;
  docType: string;
  channel: 'pos' | 'office' | null;
  prefix: string;
  numberWidth: number;
  startNumber: string;
  nextNumber: string;
  /** Once a number is used, the prefix, width and start can no longer change. */
  used: boolean;
  /** The number the next document will get, e.g. "POS-000001". */
  nextFormatted: string;
  isActive: boolean;
  rowVersion: number;
}

export interface SeriesResponse {
  series: SeriesItem[];
}

export const UpdateSeriesRequest = z.object({
  prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{1,16}$/),
  numberWidth: z.number().int().min(1).max(12),
  startNumber: z.string().regex(/^[1-9][0-9]{0,17}$/),
  rowVersion: RowVersion,
});
export type UpdateSeriesRequest = z.infer<typeof UpdateSeriesRequest>;
