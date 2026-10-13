/**
 * The point of sale and the cash drawer (M5): POS sales (POS-), held carts, returns at the POS,
 * and the drawer shift — opening, paid-in / paid-out, cash drops, No Sale, the X report, the blind
 * count, one recount, the close (Z-) and the acceptance of the over/short. Decisions 0003–0006,
 * 0055–0062. Amounts travel as whole-number text: fils, 4-decimal prices, quantities in thousandths.
 */
import { z } from 'zod';
import { IdText } from './auth';
import { NonNegativeIntText, OptionalText, Reason } from './common';
import type { DocumentDetail } from './sales';
import { SalesLineInput } from './sales';

const PositiveFils = z.string().regex(/^[1-9][0-9]{0,17}$/);
const PositiveMilli = z.string().regex(/^[1-9][0-9]{0,17}$/);
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
/** An approval code from the card terminal slip: letters and digits, never a card number (0061). */
export const CardApprovalCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{2,12}$/);

// ---------------------------------------------------------------------------------------------
// The POS state of this PC
// ---------------------------------------------------------------------------------------------

export interface PosPaymentMethod {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  kind: 'cash' | 'card' | 'bank_transfer' | 'cheque' | 'other';
  opensDrawer: boolean;
  givesChange: boolean;
}

export interface Denomination {
  id: string;
  valueFils: string;
  kind: 'note' | 'coin';
}

export interface ShiftSummary {
  id: string;
  shiftNumber: string;
  status: 'open' | 'closed';
  registerId: string;
  registerCode: string;
  cashierId: string;
  cashierName: { displayNameAr: string; displayNameEn: string };
  openedAt: string;
  closedAt: string | null;
  openingFloatFils: string;
}

export interface PosState {
  /** POS sales and shifts work only on a PC enrolled as POS (decision 0021). */
  isPosDevice: boolean;
  registerId: string | null;
  /** The signed-in user's open shift on this PC's drawer, if any. */
  shift: ShiftSummary | null;
  /** Someone else's open shift on this drawer: this user cannot sell here (decision 0004). */
  drawerBusyWith: { displayNameAr: string; displayNameEn: string } | null;
  walkInCustomerId: string;
  paymentMethods: PosPaymentMethod[];
  denominations: Denomination[];
  receiptLanguage: 'ar' | 'en' | 'both';
  /** The drawer holds more than the cash-drop alert amount (0057); the amount is never shown. */
  dropDue: boolean;
}

// ---------------------------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------------------------

/** One way of paying at the POS. Cash may be tendered above the amount (change is given). */
export const PosPaymentPart = z.object({
  paymentMethodId: IdText,
  amountFils: PositiveFils,
  /** Cash: what the customer handed over. */
  tenderedFils: PositiveFils.optional(),
  /** Card: the approval code on the terminal slip, nothing else (decision 0061). */
  approvalCode: CardApprovalCode.optional(),
});
export type PosPaymentPart = z.infer<typeof PosPaymentPart>;

/** A line removed from the cart before payment: no approval, always written to the audit log (0005). */
export const CartRemoval = z.object({
  itemId: IdText,
  quantityMilli: PositiveMilli,
  removedAt: z.string().datetime({ offset: true }),
});
export type CartRemoval = z.infer<typeof CartRemoval>;

export const PosSaleRequest = z.object({
  /** The cart's id (the screen keeps it while the cart lives). */
  cartId: Uuid,
  /** Default: the cash customer. A VAT-registered customer gets a full tax invoice (0010, 0062). */
  customerId: IdText.optional(),
  lines: z.array(SalesLineInput).min(1).max(200),
  docDiscountFils: NonNegativeIntText.optional(),
  payments: z.array(PosPaymentPart).min(1).max(5),
  /** A supervisor's approval for a discount above the cashier's limit (0059). */
  approvalId: IdText.optional(),
  /** A supervisor's approval for changed prices (always needed, 0059). */
  priceApprovalId: IdText.optional(),
  /** A supervisor's approval to sell beyond stock (0003). */
  oversellApprovalId: IdText.optional(),
  /** A supervisor's approval for an unpaid amount (a customer on credit, 0046). */
  creditApprovalId: IdText.optional(),
  removals: z.array(CartRemoval).max(500).optional(),
  heldCartId: IdText.optional(),
});
export type PosSaleRequest = z.infer<typeof PosSaleRequest>;

export interface PosPaymentResult {
  id: string;
  docNumber: string;
  methodNameAr: string;
  methodNameEn: string;
  methodKind: PosPaymentMethod['kind'];
  amountFils: string;
  tenderedFils: string | null;
  changeFils: string | null;
  reference: string | null;
}

/** Everything the thermal receipt prints, from the document as issued (decisions 0008, 0062). */
export interface ReceiptData {
  /** The seller as frozen on the document at issue. */
  seller: {
    nameAr: string;
    nameEn: string;
    addressAr: string;
    addressEn: string;
    trn: string | null;
    phone: string | null;
  };
  document: DocumentDetail;
  payments: PosPaymentResult[];
  changeFils: string;
  cashierName: { displayNameAr: string; displayNameEn: string } | null;
  shiftNumber: string | null;
  deviceCode: string;
  /** Prints so far: 0 = the original; after that every print is a copy (0008). */
  printCount: number;
  markCopies: boolean;
}

export interface PosSaleResponse {
  receipt: ReceiptData;
  document: DocumentDetail;
  payments: PosPaymentResult[];
  changeFils: string;
  /** Kick the drawer: cash was part of the payment (or a cash refund). */
  opensDrawer: boolean;
  /** An oversell adjustment now waits for the storekeeper's review (0003). */
  oversellAdjustmentNumber: string | null;
  dropDue: boolean;
}

/** Refused sale beyond stock: the items short, so the screen can ask a supervisor (0003). */
export interface StockShortage {
  itemId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  neededMilli: string;
  availableMilli: string;
}

// ---------------------------------------------------------------------------------------------
// Held carts
// ---------------------------------------------------------------------------------------------

export const HoldCartRequest = z.object({
  cartId: Uuid,
  customerId: IdText.optional(),
  label: OptionalText(100),
  cart: z.record(z.string(), z.unknown()),
});
export type HoldCartRequest = z.infer<typeof HoldCartRequest>;

export interface HeldCart {
  id: string;
  cartId: string;
  label: string | null;
  customerId: string | null;
  customerName: string | null;
  heldAt: string;
  heldByName: { displayNameAr: string; displayNameEn: string };
  cart: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Returns at the POS (decision 0060)
// ---------------------------------------------------------------------------------------------

export const PosReturnRequest = z.object({
  originalDocumentId: IdText,
  reasonCodeId: IdText,
  reasonText: Reason,
  lines: z
    .array(
      z.object({
        originalLineId: IdText,
        quantityMilli: PositiveMilli,
        returnStockStatus: z.enum(['available', 'defective']).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
  /** The supervisor's approval (credit_notes.issue), always needed at the POS. */
  approvalId: IdText,
});
export type PosReturnRequest = z.infer<typeof PosReturnRequest>;

export interface PosReturnResponse {
  receipt: ReceiptData;
  creditNote: DocumentDetail;
  refunds: PosPaymentResult[];
  opensDrawer: boolean;
}

// ---------------------------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------------------------

export const CountLines = z.object({
  lines: z
    .array(z.object({ denominationId: IdText, quantity: z.number().int().min(0).max(100_000) }))
    .max(50),
  /** Cash that is not a listed note or coin (decision 0056). */
  otherAmountFils: NonNegativeIntText.optional(),
});
export type CountLines = z.infer<typeof CountLines>;

export const OpenShiftRequest = z.object({ openingFloatFils: NonNegativeIntText });
export type OpenShiftRequest = z.infer<typeof OpenShiftRequest>;

export const CASH_MOVEMENT_TYPES = ['paid_in', 'paid_out', 'cash_drop', 'float_top_up'] as const;
export type CashMovementType = (typeof CASH_MOVEMENT_TYPES)[number];

export const CashMovementRequest = z.object({
  movementType: z.enum(CASH_MOVEMENT_TYPES),
  amountFils: PositiveFils,
  reasonCodeId: IdText.optional(),
  note: OptionalText(500),
  counterparty: OptionalText(200),
  /** A paid-out by someone without cash.paid_out (0004 supervisor approval). */
  approvalId: IdText.optional(),
});
export type CashMovementRequest = z.infer<typeof CashMovementRequest>;

export interface CashMovementItem {
  id: string;
  voucherNumber: string;
  movementType: CashMovementType | 'opening_float' | 'closing_transfer';
  direction: 'in' | 'out';
  amountFils: string;
  reasonNameAr: string | null;
  reasonNameEn: string | null;
  note: string | null;
  createdAt: string;
}

export const NoSaleRequest = z.object({ reasonCodeId: IdText, note: OptionalText(500) });
export type NoSaleRequest = z.infer<typeof NoSaleRequest>;

export const RecountRequest = CountLines.extend({ approvalId: IdText });
export type RecountRequest = z.infer<typeof RecountRequest>;

export const CloseShiftRequest = z.object({ varianceNote: OptionalText(1000) });
export type CloseShiftRequest = z.infer<typeof CloseShiftRequest>;

export const AcceptVarianceRequest = z.object({
  note: Reason,
  reasonCodeId: IdText.optional(),
});
export type AcceptVarianceRequest = z.infer<typeof AcceptVarianceRequest>;

export const ShiftsQuery = z.object({
  cashierId: IdText.optional(),
  status: z.enum(['open', 'closed']).optional(),
  /** Closed shifts whose over/short is not accepted yet. */
  pendingAcceptance: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ShiftsQuery = z.infer<typeof ShiftsQuery>;

export interface CountResult {
  countId: string;
  isRecount: boolean;
  countedFils: string;
  /** Shown only after the count (blind count, decision 0006). */
  expectedFils: string;
  varianceFils: string;
  /** A recount is still possible (one only, with approval). */
  canRecount: boolean;
}

export interface CashCountDetail {
  id: string;
  isRecount: boolean;
  totalFils: string;
  otherAmountFils: string;
  countedAt: string;
  lines: { valueFils: string; quantity: number; amountFils: string }[];
}

/** The figures of a shift: the X report (open) and the Z report (closed). */
export interface ShiftReport {
  shift: ShiftSummary;
  /** POS sales (POS- invoices). */
  salesCount: number;
  returnsCount: number;
  grossSalesFils: string;
  /** VAT and discounts of all the shift's sales: POS and A4. */
  vatFils: string;
  discountFils: string;
  returnsFils: string;
  /** A4 (INV-) invoices the cashier issued during the shift; not in the expected cash (0063). */
  a4InvoicesCount: number;
  a4InvoicesFils: string;
  /** POS sales + A4 invoices. */
  totalSalesFils: string;
  byMethod: {
    methodId: string;
    nameAr: string;
    nameEn: string;
    kind: PosPaymentMethod['kind'];
    receivedFils: string;
    refundedFils: string;
  }[];
  movements: CashMovementItem[];
  noSaleCount: number;
  /** Expected cash: hidden from the cashier while the shift is open and uncounted (0006). */
  expectedCashFils: string | null;
  counts: CashCountDetail[];
  countedCashFils: string | null;
  varianceFils: string | null;
  varianceNote: string | null;
  acceptance: {
    acceptedAt: string;
    acceptedBy: { displayNameAr: string; displayNameEn: string };
    note: string | null;
  } | null;
}

export interface ShiftListItem extends ShiftSummary {
  expectedCashFils: string | null;
  countedCashFils: string | null;
  varianceFils: string | null;
  accepted: boolean;
}

export interface ShiftsResponse {
  total: number;
  shifts: ShiftListItem[];
}

export interface CashAlert {
  id: string;
  alertType: 'cash_drop_due' | 'repeated_variance';
  createdAt: string;
  params: Record<string, unknown>;
}
