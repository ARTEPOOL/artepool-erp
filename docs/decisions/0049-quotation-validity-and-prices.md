# 0049 — Quotations are valid 15 days by default; their prices are kept on conversion

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-12 |
| **Decided by** | Owner |

## Decision
- A new quotation is valid for **15 days** (setting `sales.quotation_valid_days`), changeable per quotation.
- Prices are fixed when the quotation is sent. Converting to an invoice uses the quotation's prices, not today's.
- A sent quotation is changed only by a new revision; earlier revisions are kept.
