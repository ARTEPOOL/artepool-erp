# 0044 — Full stock counts are blind; one warehouse in Phase 1

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-11 |
| **Decided by** | Owner |

## Decision
- **Blind counts:** while a count is being entered, the person counting does not see the system quantity. The quantities and differences are shown only on the review step, to someone with `stock.count_post`.
- **The quick single-item adjustment** (design 07) keeps showing the system quantity.
- **One warehouse for now** (`MAIN`). Every movement already carries its warehouse; transfers between warehouses come in Phase 3.

## Why
- A count is only useful if the numbers are really counted, not copied.

## Consequences
- Items moved during a count are accounted for: the difference is counted − (frozen quantity + movements since the count started).
