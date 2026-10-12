# 0046 — An unpaid invoice for a cash customer needs credit or a supervisor's approval

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-12 |
| **Decided by** | Owner |

## Decision
- Customers start as cash (limit 0, [0036](0036-customers-start-as-cash.md)). An invoice for a cash customer is issued only if it is **paid in full at issue**, unless a supervisor approves (`sales.credit_over_limit`).
- A customer with credit may owe up to their limit; above it, the same approval.
- Who issues stays as the default roles say: the owner and the accountant issue (`invoices.issue`); others prepare drafts (`invoices.create`) and receive payments.

## Why
- Selling on credit is a decision about risk; it must be visible and approved.

## Consequences
- The database checks the balance against the limit at issue, inside the issuing transaction.
