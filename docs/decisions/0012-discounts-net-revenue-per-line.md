# 0012 — Discounts: revenue net of discount, stored per line

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner / accountant |

## Decision
- **Revenue is posted net of discount.** There is **no** separate "Sales discounts" account.
- **Every invoice line shows** the original price, the discount amount and the net amount.
- **The discount is stored on each line,** so reports can still show the total discounts given.

## How it works
- **Discount types:** a line discount (amount or %) and a discount on the whole invoice.
- **Whole-invoice discounts are spread across the lines before VAT,** in proportion to each line's value. The shares always add up exactly to the discount given, so VAT stays correct per line.
- **Each line stores:**
  - original unit price (4 decimals)
  - amount before discount
  - line discount (and the % if one was entered)
  - share of the invoice discount
  - net amount
  - VAT
  - line total
- **Discount limits:** staff limits are percent and amount per role, with an optional per-user override. Above the limit, a supervisor approval is needed.
- **Accounts:** revenue receives only the net amount. The discount appears in reports, not in the accounts.
