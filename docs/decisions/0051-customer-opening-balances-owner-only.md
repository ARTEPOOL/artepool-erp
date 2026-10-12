# 0051 — Customer opening balances: once at go-live, owner only

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-12 |
| **Decided by** | Owner |

## Decision
- Customer opening balances (what each customer owes, or is owed, at go-live) are entered **once**, by hand or from Excel, by the **owner only** (permission `customers.opening`).
- The journal entry is Customer receivable / Opening balance equity (posting map row 20). Later changes are credit or debit notes.

## Why
- Same rule as opening stock ([0042](0042-opening-stock-owner-only.md)).
