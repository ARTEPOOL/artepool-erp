# 0113 — Receipts settle open invoices first; one derived status per invoice

| | |
|---|---|
| **Status** | Accepted (2026-10-29) |
| **Date** | 2026-10-29 |
| **Decided by** | Owner |
| **Related** | [0013](0013-advance-and-progress-payments-vat.md) advance payments; [0046](0046-unpaid-invoice-for-cash-customers.md) cash customers; [0052](0052-payment-allocation-oldest-first.md) oldest first; [0072](0072-cancel-or-edit-issued-invoice.md) cancel and edit |

## What happened

The owner issued INV-000001 (60.00, cash customer, unpaid), then received 60.00 from the invoice's "Receive payment" button. The receipt did not settle INV-000001: it became a new advance payment invoice INV-000002. The owner then cancelled INV-000002, so the list showed three rows for one sale.

The server followed 0052. The receipt screen did not:
- it opened with the customer only, not the invoice;
- "Choose invoices" with no amount typed was sent as "advance only";
- "Advance only" could be pressed while invoices were open;
- nothing said, before saving, that an advance payment invoice would be created.

## Decision

1. **A receipt settles open invoices first** (opening balance, then invoices and debit notes, oldest first, 0052). Amounts chosen per invoice are settled first; **what is left still goes to the other open invoices, oldest first**. Only the excess, once nothing is left open, becomes an advance with its own payment tax invoice (0013).
2. **The exception:** keeping a receipt (or its remainder) as an advance while invoices are still open is allowed only:
   - with the permission `sales.advance_with_open_invoices` (owner and accountant; never the cashier);
   - with a reason (kept on the receipt and in the audit log);
   - after a warning that lists the open invoices.

   The case is contracting: a customer may pay a deposit for a new project while an old invoice is disputed. **Pending accountant review** (see the questions for the accountant).
3. **Receiving from an invoice** opens the receipt on that invoice, with the amount still due filled in. Before saving, the screen says what will happen: "Settles INV-…" and/or "Creates an advance payment invoice of X (VAT Y)". Creating an advance payment invoice asks for confirmation.
4. **One status per invoice, worked out, never typed.** The invoice itself never changes after issue (golden rule 3). What it has received is kept by the database from the receipts and credit notes applied to it, in the same transaction; an integrity check compares it with them. The status shown:
   - unpaid → partially paid → paid;
   - **overdue**: it has a due date that has passed and is not fully paid. The due date is set at issue from the customer's payment terms (credit 30 days → issue date + 30; cash customers "on receipt" → the issue date, so an unpaid one is overdue from the next day);
   - **partially credited**: a credit note covers part of it;
   - **cancelled**: fully credited by Cancel or Edit (0072), with the credit note's number.
5. **Credit notes** are created from the invoice they correct, with its lines filled in, and always reference it (the database refuses one without an original).
6. **The Invoices section has tabs:** Invoices (with advance payment invoices, marked "Advance payment invoice": they are tax invoices in the INV series) / Credit notes / Debit notes. Receipts keep their own section. The invoice page shows a timeline: issued → receipts (amount, method) → credit notes (amount, refund) → refunds.

## Why

A receipt for an invoice must pay that invoice. An advance payment invoice is a tax document that must not appear by surprise. The exception exists because contracting needs it, but it is limited by permission, reason and audit.
