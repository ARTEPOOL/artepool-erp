# 0040 — Stock cost and value: owner and accountant only

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-11 |
| **Decided by** | Owner |

## Decision
- **Average cost, stock value, and the values in adjustments, counts and journal entries** are shown only to people with `stock.view_cost`: by default the **owner and the accountant**.
- **The storekeeper and the cashier see quantities only.**
- **The purchase price field on the item stays owner-only** (`items.cost`, [0038](0038-item-purchase-price-owner-only.md)).

## Why
- The accountant needs inventory values to keep the books; nobody else needs to know what goods cost.

## How it works
- The API leaves value fields out of its answers for anyone without `stock.view_cost`; screens hide the matching columns, tiles and totals.
- The journal viewer needs `ledger.view` (owner and accountant by default).

## Consequences
- A storekeeper can count and adjust stock without seeing what the difference is worth; the approval threshold (0041) is still applied by the server on the real value.
