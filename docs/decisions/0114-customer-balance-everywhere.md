# 0114 — The customer's balance wherever a customer is chosen

| | |
|---|---|
| **Status** | Accepted (2026-10-29) |
| **Date** | 2026-10-29 |
| **Decided by** | Owner |
| **Related** | [0013](0013-advance-and-progress-payments-vat.md) advance payments; [0036](0036-customers-start-as-cash.md) credit; [0046](0046-unpaid-invoice-for-cash-customers.md) over the limit; [0051](0051-customer-opening-balances-owner-only.md) opening balances; [0071](0071-a4-invoices-full-and-reprints-current-design.md) reprints; [0113](0113-receipts-settle-invoices-first.md) overdue |

## Decision

1. **What the balance is, computed from posted documents only, never typed:**
   - **Outstanding:** what the customer owes. That is issued invoices and debit notes still due, the opening balance still due, less unapplied credit notes and an opening balance owed to the customer. It is the same number the credit-limit rule uses (0046).
   - **Overdue:** the part of it whose due date has passed (0113), the opening balance included.
   - **Credit limit:** 0 for a cash customer.
   - **Available:** credit limit − outstanding.
   - **Advance payments:** payment tax invoices not yet deducted (0013). They have their own line, are **not** subtracted from Outstanding, and do **not** add to the available credit (conservative).
   - **Net position** (customer page and statement): outstanding − advance payments.
2. **A banner under the customer** on the A4 invoice, the POS (a named customer) and the receipt screens:
   - **green:** nothing due;
   - **yellow:** within the limit;
   - **orange:** overdue invoices, or 80% of the limit or more;
   - **red:** over the limit. An unpaid sale then needs a supervisor's approval (0046).

   For a **cash customer** the banner appears only when they owe something, and it is then red (limit 0). The walk-in cash customer has no banner.
3. **Who sees amounts:** the permission `customers.balance.view` (owner and accountant; the owner can give it to others). Everyone else sees the colour and the status words only: "nothing due", "within the limit", "near the limit", "has overdue invoices", "over the limit — approval needed". The server never sends them the amounts.
4. **Customers list:** an Outstanding column, sortable (with the permission), and the filter "has overdue invoices".
5. **Customer page:** outstanding, overdue, advance payments, net position, the open invoices with their age and days overdue, the oldest unpaid date, and the statement.
6. **Printed block on A4 invoices** (Print designer, optional):
   - The lines are "Previous balance / This invoice / Paid now (when something was paid at issue) / Total due".
   - It is on by default for credit customers, can be set to every named customer or off, and is never printed for the walk-in customer.
   - The previous balance, what was paid at issue and whether the customer was on credit are **stored with the invoice when it is issued**, so a reprint shows the same numbers. The look follows today's design (0071).

## Why

The person at the counter or in the office must see, before selling on credit, whether the customer is within the limit or late, without opening another screen. Amounts stay with the people allowed to see them.

## How it is built

- **Server:** `GET /customers/:id/balance` sends the status, the credit mode and the walk-in flag to everyone who can see customers, and the amounts only with `customers.balance.view`; `?detail=yes` adds the open invoices with their age and days overdue and the oldest unpaid date. The customers list takes `balance=yes`, `overdue=yes` and `sort=outstanding` (the sort is refused without the permission). The colour rule is one shared function (`balanceStatus`), used by the server, the screens and the tests.
- **Printed block:** migration 0049 adds `balance_before_fils`, `paid_at_issue_fils` and `credit_customer` to `sales.documents`, set in the update that issues an invoice (A4 or POS) and frozen afterwards by the database guard. Drafts and invoices issued before version 0.7.0 print no block. Arabic labels: الرصيد السابق / هذه الفاتورة / المدفوع الآن / إجمالي الرصيد المستحق.
- **Statement:** the screen and the PDF also show today's outstanding, advance payments and net position.
- **Colours:** green, yellow and red use the existing success, warning and danger tokens; orange is a new token `--color-caution` (light and dark), added to the approved token file `design/artepool-tokens.css`.
