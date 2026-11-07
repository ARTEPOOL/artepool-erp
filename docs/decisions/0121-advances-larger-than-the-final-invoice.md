# 0121 — Advance payments larger than the final invoice: partial deduction

| | |
|---|---|
| **Status** | Accepted (2026-11-07). Pending accountant review (question added to the accountant pack, Q2) |
| **Date** | 2026-11-07 |
| **Decided by** | Owner |
| **Changes** | 0013 (the final invoice deducted every chosen payment in full, and was refused when the payments were more than the invoice) |

## Decision

When the earlier payments chosen on a final invoice are more than that invoice:

1. **Only the invoice's amount is deducted**, net and VAT, never more than the invoice's own net and VAT in that VAT category. The payments are deducted in the order chosen.
2. **The rest stays as the customer's advance payment** (account 2120, with its VAT already charged) for later invoices.
3. **Before saving**, the invoice screen says clearly, for each chosen payment: «سيُخصم X من INV-…، ويبقى Y دفعة مقدمة للعميل» / "X will be deducted from INV-…; Y stays as the customer's advance".
4. **«ردّ المتبقي» / "Refund the remainder"** on the payment invoice: a credit note on the payment invoice for what is left, and the refund, in one step (posting map lines 9 and 10). It needs `payments.refund`, like any refund.
5. **The remaining advance shows** on the customer page, the statement and the balance banner, on its own line (0114): it is never subtracted from what is owed.

## Why

- A customer may pay more in advance than the final work costs (a smaller pool, a cancelled extra). Refusing the final invoice left no way to invoice the work.
- Deducting only the invoice's amount keeps VAT counted once: the VAT on the rest was already charged on the payment invoice, and stays there until the rest is used or refunded.

## How it works

- The server caps each deduction line by what is left of the invoice's net and VAT in the payment's VAT category. A payment with nothing left to deduct gets no line.
- The database already refuses a deduction beyond what remains of a payment, and records the used part on the payment invoice. What remains is the payment's net and VAT minus the used part, as before.
- Journal entries are unchanged: line 6 (the final invoice) with the deducted net on 2120; lines 9 and 10 for the refund.

## Consequences

- A final invoice can come to **0.00 due**: it is covered by the payment.
- Accountant question (pack Q2): is the partial deduction, with the rest kept on 2120 or refunded by a credit note on the payment invoice, acceptable? And what if a final invoice mixes VAT categories (for example zero-rated and standard)? Today each payment is deducted only against lines of its own category.
