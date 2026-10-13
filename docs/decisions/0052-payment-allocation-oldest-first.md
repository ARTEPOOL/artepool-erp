# 0052 — A payment without chosen invoices settles the oldest first; the rest is an advance

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-12 |
| **Decided by** | Owner |

## Decision
- When a payment is received without choosing invoices, it settles the customer's **oldest open invoices first** (opening balances included).
- Any remainder becomes an **advance/progress payment** with its own payment tax invoice ([0013](0013-advance-and-progress-payments-vat.md)).
- The person receiving can choose the invoices instead.
