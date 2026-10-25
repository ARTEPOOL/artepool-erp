# 0072 — Cancelling or editing an issued A4 invoice, with the owner's approval

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-17 |
| **Decided by** | Owner |
| **Refines** | Golden rules 2 and 3 (no deletes; posted documents immutable) |

## Decision
An issued tax invoice is never changed or deleted. UAE VAT rules require that, and so do golden rules 2 and 3. Instead, an issued **A4** invoice has two buttons:

- **Cancel invoice**:
  - A **credit note for the whole invoice** is issued at once.
  - Its goods go back to sellable stock at the cost they left with, and its VAT is reversed.
  - What the customer **paid is refunded now**, through the ways chosen in the dialog (cash by default), exactly the paid amount.
  - Any unpaid part is settled by the credit note.
- **Edit invoice**: the same, then a **new draft copied from it** opens. It has the customer, typed name and address, PO, notes, lines, prices and discounts. The customer and the items can be changed there before issuing; the new invoice gets a new number.

**Rules:**
- **Who:** the owner (new owner-only permission `invoices.cancel`). Anyone else needs the **owner's approval**, given in the app for that very invoice.
- A written **reason** is required. Everything is in the audit log.
- The original invoice stays, marked "Cancelled" or "Replaced (edited)" with the credit note's number.
- **Not available:**
  - when a credit or debit note was already issued against the invoice;
  - when the invoice deducts earlier payments (0013);
  - on POS sales, which use the Return button (0060).
  In those cases a credit note is made by hand.

## Why
- The owner needs to correct a wrong customer or wrong items after issuing. A full credit note plus a new invoice is the legal way to do that.
- One button does it in one transaction: credit note, stock, VAT, refund and the new draft.

## Consequences
- Migration 0026: the permission, and the credit-note reasons "Invoice cancelled" and "Invoice edited (replaced)".
- Drafts (before issuing) are still edited and discarded freely.
