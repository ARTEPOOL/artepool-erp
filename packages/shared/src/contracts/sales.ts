/**
 * Sales (M4): quotations (Q-), tax documents (INV-, CN-, DN-), receipts (RCT-), refunds (RFD-),
 * reversals (RVS-), customer opening balances and statements. Amounts travel as whole-number text:
 * fils, 4-decimal prices, quantities in thousandths. The server (and the database behind it) works
 * out every line; amounts a screen shows before saving are previews from the same shared helper.
 */
import { z } from 'zod';
import { IdText } from './auth';
import { NonNegativeIntText, OptionalText, Reason, RowVersion } from './common';
import { DateText, STOCK_STATUSES, type StockStatus } from './inventory';

const PositiveMilli = z.string().regex(/^[1-9][0-9]{0,17}$/);
const PositiveFils = z.string().regex(/^[1-9][0-9]{0,17}$/);

export const DOC_TYPES = ['invoice', 'advance_invoice', 'credit_note', 'debit_note'] as const;
export type DocType = (typeof DOC_TYPES)[number];
export type DocStatus = 'draft' | 'issued' | 'discarded';
export type SettlementStatus = 'open' | 'partial' | 'settled';
export type InvoiceFormat = 'full' | 'simplified';

// ---------------------------------------------------------------------------------------------
// Lines (shared by quotations and invoices)
// ---------------------------------------------------------------------------------------------

export const SalesLineInput = z.object({
  itemId: IdText,
  quantityMilli: PositiveMilli,
  /** Defaults to the item's price; a different price needs sales.price_override or an approval. */
  unitPrice4dp: NonNegativeIntText.optional(),
  /** A discount on this line, in fils on the price's basis (with VAT if the price includes it)… */
  lineDiscountFils: NonNegativeIntText.optional(),
  /** …or as a percentage in basis points (500 = 5%). */
  lineDiscountBp: z.number().int().min(0).max(10_000).optional(),
  descriptionAr: OptionalText(500),
  descriptionEn: OptionalText(500),
  businessLineId: IdText.optional(),
  isOptional: z.boolean().optional(),
  note: OptionalText(1000),
  /** Invoices made from a quotation: the quotation line, whose agreed price it keeps (0049). */
  quotationLineId: IdText.optional(),
});
export type SalesLineInput = z.infer<typeof SalesLineInput>;

export interface SalesLine {
  id: string;
  lineNo: number;
  lineKind: 'item' | 'advance' | 'advance_deduction';
  itemId: string | null;
  itemCode: string | null;
  descriptionAr: string;
  descriptionEn: string;
  unitId: string | null;
  businessLineId: string;
  quantityMilli: string;
  listPrice4dp: string;
  unitPrice4dp: string;
  priceIncludesVat: boolean;
  amountBeforeDiscountFils: string;
  lineDiscountFils: string;
  /** The discount as typed in percent (basis points), when it was a percentage. */
  lineDiscountBp?: number | null;
  docDiscountAllocFils: string;
  discountExclVatFils: string;
  netFils: string;
  vatCategoryId: string;
  vatRateBp: number;
  vatFils: string;
  grossFils: string;
  isOptional?: boolean;
  /** Invoice lines converted from a quotation (decision 0049). */
  quotationLineId?: string | null;
  /** Deductions: the payment invoice deducted (decision 0013). */
  advanceDocumentId?: string | null;
  advanceDocumentNumber?: string | null;
  /** Notes: the original line and where returned goods go. */
  originalLineId?: string | null;
  returnStockStatus?: StockStatus | null;
  /** Credited so far against this line (invoices), so a note offers only what is left. */
  creditedMilli?: string;
  note: string | null;
}

export interface Totals {
  discountTotalFils: string;
  netFils: string;
  vatFils: string;
  totalFils: string;
}

// ---------------------------------------------------------------------------------------------
// Quotations (Q-, decision 0049)
// ---------------------------------------------------------------------------------------------

export const QUOTATION_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'rejected',
  'expired',
  'converted',
  'cancelled',
  'superseded',
] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

export const SaveQuotationRequest = z.object({
  customerId: IdText,
  businessLineId: IdText.optional(),
  quotationDate: DateText.optional(),
  /** Defaults to the date + sales.quotation_valid_days (15). */
  validUntil: DateText.optional(),
  subject: OptionalText(300),
  /** The customer's own purchase order number (decision 0066). */
  customerPo: OptionalText(50),
  termsAr: OptionalText(4000),
  termsEn: OptionalText(4000),
  notes: OptionalText(2000),
  docDiscountFils: NonNegativeIntText.optional(),
  lines: z.array(SalesLineInput).min(1).max(500),
  rowVersion: RowVersion.optional(),
});
export type SaveQuotationRequest = z.infer<typeof SaveQuotationRequest>;

export const QuotationActionRequest = z.object({
  action: z.enum(['send', 'accept', 'reject', 'cancel', 'expire']),
  rowVersion: RowVersion,
});
export type QuotationActionRequest = z.infer<typeof QuotationActionRequest>;

export const QuotationsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(QUOTATION_STATUSES).optional(),
  customerId: IdText.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type QuotationsQuery = z.infer<typeof QuotationsQuery>;

export interface QuotationItem extends Totals {
  id: string;
  docNumber: string;
  revision: number;
  status: QuotationStatus;
  customerId: string;
  customerName: string;
  quotationDate: string;
  validUntil: string;
  subject: string | null;
  convertedDocumentId: string | null;
  rowVersion: number;
}

export interface QuotationDetail extends QuotationItem {
  businessLineId: string;
  billToName: string;
  billToTrn: string | null;
  customerPo: string | null;
  termsAr: string | null;
  termsEn: string | null;
  notes: string | null;
  docDiscountFils: string;
  revisedFromId: string | null;
  /** Earlier and later revisions of the same number. */
  revisions: { id: string; revision: number; status: QuotationStatus }[];
  /** Payments received against this quotation (advances, decision 0013). */
  paymentsFils: string;
  lines: SalesLine[];
}

export interface QuotationsResponse {
  total: number;
  quotations: QuotationItem[];
}

// ---------------------------------------------------------------------------------------------
// Tax documents
// ---------------------------------------------------------------------------------------------

export const SaveInvoiceRequest = z.object({
  customerId: IdText,
  businessLineId: IdText.optional(),
  issueDate: DateText.optional(),
  supplyDate: DateText.optional(),
  dueDate: DateText.optional(),
  quotationId: IdText.optional(),
  /** The customer's own purchase order number (decision 0066). */
  customerPo: OptionalText(50),
  /**
   * Printed on the full tax invoice (decision 0071): the address for any customer (else the one
   * on file), the name for the walk-in cash customer only.
   */
  billToName: OptionalText(200),
  billToAddress: OptionalText(500),
  notes: OptionalText(2000),
  internalNote: OptionalText(2000),
  docDiscountFils: NonNegativeIntText.optional(),
  lines: z.array(SalesLineInput).min(1).max(500),
  /** Payment invoices to deduct (decision 0013); the whole remainder of each by default. */
  deductions: z
    .array(z.object({ advanceDocumentId: IdText }))
    .max(100)
    .optional(),
  rowVersion: RowVersion.optional(),
});
export type SaveInvoiceRequest = z.infer<typeof SaveInvoiceRequest>;

/** One way of paying (several make a split payment). Never a full card number. */
export const PaymentPart = z.object({
  paymentMethodId: IdText,
  amountFils: PositiveFils,
  reference: OptionalText(100),
  chequeDate: DateText.optional(),
  chequeBank: OptionalText(100),
});
export type PaymentPart = z.infer<typeof PaymentPart>;

export const IssueRequest = z.object({
  rowVersion: RowVersion,
  /** A supervisor's approval for a discount above the limit. */
  approvalId: IdText.optional(),
  /** A supervisor's approval for prices different from the items' (a separate approval). */
  priceApprovalId: IdText.optional(),
  /** A supervisor's approval for an unpaid amount above the customer's credit (0046). */
  creditApprovalId: IdText.optional(),
  /** Paid at issue, in the same transaction. */
  payments: z.array(PaymentPart).max(10).optional(),
});
export type IssueRequest = z.infer<typeof IssueRequest>;

export const DiscardRequest = z.object({ rowVersion: RowVersion });
export type DiscardRequest = z.infer<typeof DiscardRequest>;

export const CreateNoteRequest = z.object({
  kind: z.enum(['credit_note', 'debit_note']),
  originalDocumentId: IdText,
  reasonCodeId: IdText,
  reasonText: Reason,
  issueDate: DateText.optional(),
  /** Item lines: which original lines, how many, at what price, and where returned goods go. */
  lines: z
    .array(
      z.object({
        originalLineId: IdText,
        quantityMilli: PositiveMilli,
        unitPrice4dp: NonNegativeIntText.optional(),
        returnStockStatus: z.enum(STOCK_STATUSES).nullable().optional(),
      }),
    )
    .max(500)
    .optional(),
  /** A credit note on a payment invoice (work cancelled): the amount with VAT to reverse. */
  advanceAmountFils: PositiveFils.optional(),
  approvalId: IdText.optional(),
  /** Credit notes: pay the money back now (otherwise it is kept as the customer's credit). */
  refund: z.array(PaymentPart).max(10).optional(),
});
export type CreateNoteRequest = z.infer<typeof CreateNoteRequest>;

/**
 * Cancel an issued A4 invoice, or cancel it to edit it (decision 0072): a credit note for the
 * whole invoice, the paid money refunded at once, and for "edit" a new draft copied from it.
 * The owner's permission, or the owner's approval.
 */
export const CancelInvoiceRequest = z.object({
  mode: z.enum(['cancel', 'edit']),
  reason: Reason,
  approvalId: IdText.optional(),
  /** How the paid amount goes back; together exactly what the customer paid. */
  refund: z.array(PaymentPart).max(10).optional(),
  rowVersion: RowVersion,
});
export type CancelInvoiceRequest = z.infer<typeof CancelInvoiceRequest>;

export interface CancelInvoiceResponse {
  creditNote: DocumentDetail;
  /** The new draft to edit ("edit" only). */
  draftId: string | null;
}

export const DocumentsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  docType: z.enum(DOC_TYPES).optional(),
  /**
   * `issued`: every issued document (cancelled ones too); `active`: issued and not cancelled;
   * `cancelled`: issued and then cancelled or replaced by a credit note for all of it (0072);
   * `discarded`: drafts thrown away. Without a status: everything but discarded drafts.
   */
  status: z.enum(['draft', 'issued', 'active', 'cancelled', 'discarded']).optional(),
  /** `unpaid`: not fully settled; `overdue`: past its due date and not fully settled (0113). */
  settlement: z.enum(['open', 'partial', 'settled', 'unpaid', 'overdue']).optional(),
  /**
   * The Invoices section's tabs (0113): `invoices` = invoices and advance payment invoices;
   * `credit_notes`; `debit_notes`.
   */
  group: z.enum(['invoices', 'credit_notes', 'debit_notes']).optional(),
  customerId: IdText.optional(),
  from: DateText.optional(),
  to: DateText.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type DocumentsQuery = z.infer<typeof DocumentsQuery>;

export interface DocumentItem extends Totals {
  id: string;
  docType: DocType;
  invoiceFormat: InvoiceFormat;
  status: DocStatus;
  docNumber: string | null;
  channel: 'pos' | 'office';
  customerId: string;
  customerName: string;
  issueDate: string | null;
  dueDate: string | null;
  settledFils: string;
  settlementStatus: SettlementStatus;
  /** Payment invoices: what remains to deduct (net and VAT). */
  advanceLeftNetFils?: string;
  advanceLeftVatFils?: string;
  originalDocumentId: string | null;
  originalDocumentNumber: string | null;
  quotationId: string | null;
  printCount: number;
  rowVersion: number;
  /** The credit note that cancelled (or replaced, `edited`) this issued invoice (0072). */
  cancelledBy: { id: string; docNumber: string; edited: boolean } | null;
  /** What credit notes applied to this invoice cover (0113: "partially credited"). */
  creditedFils: string;
  /** Issued, not cancelled, not fully settled, and its due date has passed (0113). */
  overdue: boolean;
}

export interface DocumentDetail extends DocumentItem {
  businessLineId: string;
  billToName: string;
  billToNameAlt: string | null;
  billToTrn: string | null;
  billToAddress: string | null;
  billToPhone: string | null;
  customerPo: string | null;
  supplyDate: string | null;
  issuedAt: string | null;
  issuedByName: { displayNameAr: string; displayNameEn: string } | null;
  docDiscountFils: string;
  reasonCodeId: string | null;
  reasonText: string | null;
  notes: string | null;
  internalNote: string | null;
  journalEntryId: string | null;
  lines: SalesLine[];
  /** Receipts and credit notes that settled it. */
  settlements: {
    kind: 'payment' | 'credit_note';
    id: string;
    docNumber: string;
    date: string;
    amountFils: string;
  }[];
  /** The payment invoices of the same customer that can still be deducted (draft invoices). */
  deductible?: DocumentItem[];
  /** Issued invoices: any credit or debit note already issued against it. */
  hasNotes?: boolean;
  /** Cancelled (or replaced by an edit) with the owner's approval (decision 0072). */
}

export interface DocumentsResponse {
  total: number;
  documents: DocumentItem[];
}

// ---------------------------------------------------------------------------------------------
// Receipts, refunds, reversals (decisions 0013, 0048, 0052)
// ---------------------------------------------------------------------------------------------

export const ReceivePaymentRequest = z.object({
  customerId: IdText,
  paymentDate: DateText.optional(),
  part: PaymentPart,
  /** What it settles; without it, the oldest open documents first (0052). */
  allocations: z
    .array(
      z.object({
        documentId: IdText.optional(),
        openingBalanceId: IdText.optional(),
        amountFils: PositiveFils,
      }),
    )
    .max(200)
    .optional(),
  /**
   * Keep what the chosen amounts leave as an advance (with its own payment tax invoice) instead of
   * settling the other open debts. While debts are still open this needs the permission
   * sales.advance_with_open_invoices and `advanceReason` (decision 0113).
   */
  asAdvance: z.boolean().optional(),
  advanceReason: OptionalText(500),
  /** The agreement an advance belongs to (deducted by its final invoice). */
  quotationId: IdText.optional(),
  /** The line of business and VAT category of an advance (default: the quotation's, else 5%). */
  businessLineId: IdText.optional(),
  vatCategoryId: IdText.optional(),
  notes: OptionalText(1000),
});
export type ReceivePaymentRequest = z.infer<typeof ReceivePaymentRequest>;

/** An active payment method the office can use (any user who may see sales). */
export interface SalesPaymentMethod {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  kind: 'cash' | 'card' | 'bank_transfer' | 'cheque' | 'other';
  requiresReference: boolean;
  givesChange: boolean;
}

export const ReversePaymentRequest = z.object({
  reasonCodeId: IdText,
  approvalId: IdText.optional(),
  notes: OptionalText(1000),
});
export type ReversePaymentRequest = z.infer<typeof ReversePaymentRequest>;

export const PaymentsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(['receipt', 'refund', 'reversal']).optional(),
  methodKind: z.enum(['cash', 'card', 'bank_transfer', 'cheque', 'other']).optional(),
  customerId: IdText.optional(),
  from: DateText.optional(),
  to: DateText.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type PaymentsQuery = z.infer<typeof PaymentsQuery>;

export interface PaymentItem {
  id: string;
  paymentKind: 'receipt' | 'refund' | 'reversal';
  status: 'posted' | 'reversed';
  docNumber: string;
  customerId: string;
  customerName: string;
  paymentMethodId: string;
  methodKind: string;
  amountFils: string;
  paymentDate: string;
  reference: string | null;
  reversalOfId: string | null;
}

export interface PaymentDetail extends PaymentItem {
  chequeDate: string | null;
  chequeBank: string | null;
  notes: string | null;
  /** Why this receipt was kept as an advance while invoices were open (decision 0113). */
  advanceReason: string | null;
  receivedByName: { displayNameAr: string; displayNameEn: string } | null;
  allocations: {
    documentId: string | null;
    openingBalanceId: string | null;
    docNumber: string | null;
    docType: DocType | 'opening_balance';
    amountFils: string;
  }[];
  /** The payment invoice this receipt created for its unallocated part, if any. */
  advanceDocumentId: string | null;
  journalEntryId: string | null;
}

export interface PaymentsResponse {
  total: number;
  payments: PaymentItem[];
}

export interface ReceivePaymentResponse {
  payment: PaymentDetail;
  /** The payment invoice (INV-) issued for the part that settled nothing (0013). */
  advanceInvoice: DocumentDetail | null;
}

// ---------------------------------------------------------------------------------------------
// Opening balances and the statement (decision 0051)
// ---------------------------------------------------------------------------------------------

export const OpeningBalanceRequest = z.object({
  customerId: IdText,
  direction: z.enum(['receivable', 'payable']),
  amountFils: PositiveFils,
  balanceDate: DateText.optional(),
  reference: OptionalText(100),
  dueDate: DateText.optional(),
});
export type OpeningBalanceRequest = z.infer<typeof OpeningBalanceRequest>;

export interface OpeningBalanceItem {
  id: string;
  customerId: string;
  balanceDate: string;
  direction: 'receivable' | 'payable';
  amountFils: string;
  settledFils: string;
  reference: string | null;
}

export const StatementQuery = z.object({ from: DateText, to: DateText });
export type StatementQuery = z.infer<typeof StatementQuery>;

export interface StatementLine {
  date: string;
  kind: DocType | 'receipt' | 'refund' | 'reversal' | 'opening_balance';
  id: string;
  docNumber: string | null;
  /** What the customer owes more (debit) or less (credit). */
  debitFils: string;
  creditFils: string;
  balanceFils: string;
}

export interface StatementResponse {
  customerId: string;
  from: string;
  to: string;
  openingFils: string;
  lines: StatementLine[];
  closingFils: string;
}

/** The customer's position right now: what they owe (positive) or are owed (negative). */
export interface CustomerBalance {
  balanceFils: string;
  creditMode: 'cash' | 'credit';
  creditLimitFils: string;
  /** Unused advances (payment invoices not yet deducted), with VAT. */
  advancesFils: string;
}
