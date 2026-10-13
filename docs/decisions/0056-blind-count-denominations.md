# 0056 — Shift count: denominations down to 0.05 AED plus an "other amount"

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-13 |
| **Decided by** | Owner |

## Decision
- The blind count at shift close is entered by denomination: notes **1000, 500, 200, 100, 50, 20, 10, 5**; coins **1, 0.50, 0.25, 0.10, 0.05** AED.
- Plus one **"Other amount"** field (in AED and fils) for anything else.
- There is no cash rounding (golden rule), so the count is exact to the fils and can match the expected amount exactly.

## Why
- Totals are exact to the fils; the count must be able to be exact too.

## Consequences
- The count is kept per denomination with the shift; both counts (first and recount, 0006) appear on the Z report.
