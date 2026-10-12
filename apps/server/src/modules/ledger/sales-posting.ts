/**
 * The journal entries of sales (docs/accounting/posting-map.md rows 1–11 and 20). Pure functions:
 * they turn a document's figures into signed amounts (positive = debit), which postEntry writes.
 * Revenue and cost of sales use the accounts of each line's line of business; money uses the
 * payment method's account (in the office: its office account, decision 0047).
 */
import type { PostingAmount } from './posting';

export interface PostingLine {
  kind: 'item' | 'advance' | 'advance_deduction';
  netFils: bigint;
  businessLineId: bigint;
  revenueAccountId: bigint;
  cogsAccountId: bigint;
  /** Stock value that left (invoices) or came back (credit note returns), in fils. */
  costFils: bigint;
  /** Credit notes: where returned goods went. */
  returnStockStatus?: 'available' | 'defective' | null;
}

export interface PostingDocument {
  docType: 'invoice' | 'advance_invoice' | 'credit_note' | 'debit_note';
  customerId: bigint;
  totalFils: bigint;
  vatFils: bigint;
  lines: PostingLine[];
}

/** Rows 1, 2, 4, 6, 7, 8, 9: one entry per issued document. */
export function documentPosting(doc: PostingDocument): PostingAmount[] {
  // Invoices and debit notes add to what the customer owes; credit notes take it away.
  const sign = doc.docType === 'credit_note' ? -1n : 1n;
  const amounts: PostingAmount[] = [
    { link: 'ar_control', fils: sign * doc.totalFils, customerId: doc.customerId },
    { link: 'vat_output', fils: -sign * doc.vatFils },
  ];
  for (const l of doc.lines) {
    if (l.kind === 'item') {
      amounts.push({
        link: { accountId: l.revenueAccountId },
        fils: -sign * l.netFils,
        businessLineId: l.businessLineId,
      });
      if (l.costFils > 0n) {
        // Goods leave at their cost (row 2) or come back at the cost they left with (row 8).
        const stockLink =
          doc.docType === 'credit_note' && l.returnStockStatus === 'defective'
            ? 'inventory_defective'
            : 'inventory';
        amounts.push(
          {
            link: { accountId: l.cogsAccountId },
            fils: sign * l.costFils,
            businessLineId: l.businessLineId,
          },
          { link: stockLink, fils: -sign * l.costFils },
        );
      }
    } else {
      // A payment invoice holds its net as Customer advances (row 4); a final invoice releases it
      // (row 6, the deduction lines are negative); a credit note on it reverses it (row 9).
      amounts.push({ link: 'customer_advances', fils: -sign * l.netFils });
    }
  }
  return amounts;
}

export interface PostingPayment {
  kind: 'receipt' | 'refund' | 'reversal';
  /** For a reversal: the direction of the payment it undoes. */
  reversedKind?: 'receipt' | 'refund';
  customerId: bigint;
  amountFils: bigint;
  methodAccountId: bigint;
}

/** Rows 3, 5, 10, 11: money in or out, against what the customer owes. */
export function paymentPosting(p: PostingPayment): PostingAmount[] {
  const moneyIn = p.kind === 'receipt' || (p.kind === 'reversal' && p.reversedKind === 'refund');
  const sign = moneyIn ? 1n : -1n;
  return [
    { link: { accountId: p.methodAccountId }, fils: sign * p.amountFils },
    { link: 'ar_control', fils: -sign * p.amountFils, customerId: p.customerId },
  ];
}

/** Row 20: what a customer owed (or was owed) at go-live. */
export function openingBalancePosting(o: {
  customerId: bigint;
  direction: 'receivable' | 'payable';
  amountFils: bigint;
}): PostingAmount[] {
  const sign = o.direction === 'receivable' ? 1n : -1n;
  return [
    { link: 'ar_control', fils: sign * o.amountFils, customerId: o.customerId },
    { link: 'opening_balance_equity', fils: -sign * o.amountFils },
  ];
}
