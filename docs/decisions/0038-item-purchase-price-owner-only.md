# 0038 — The item's purchase price: without VAT, owner only, copied onto each sale

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-11 |
| **Decided by** | Owner |

## Decision
- **Every stock item and service has an optional "Purchase price"**, typed on the item screen and in the Excel template.
- **Without VAT.** Input VAT on purchases is recoverable, so it is never part of the cost.
- **4-decimal precision** (`*_4dp`), like sale prices.
- **Only the owner sees or changes it,** with the new owner-only permission `items.cost`. The accountant, the cashier and the storekeeper are never sent it. The database refuses a change without the permission.
- **A kit has no purchase price of its own.** Its cost is the sum of its components' costs (quantity × price), and is unknown while any component has none.
- **It is a starting cost.** When purchases and stock movements exist, the weighted-average cost (kept per warehouse in the stock ledger) takes over automatically; the owner then does not have to keep the price up to date.
- **Every sale keeps a copy of the cost it was valued at, when it happens.** Changing the purchase price later never changes the profit of past sales or reports.

## Why
- The owner wants monthly reports of what was sold and the real profit.
- Profit that follows a typed number would be wrong whenever the price changes and the number is forgotten. The average of the real purchases is the usual accounting treatment, and a copy on each sale keeps old reports stable.

## How it works
- **Column:** `md.items.fallback_unit_cost_4dp` (from migration 0009, no longer limited to stock items). Migration 0010 allows services, keeps kits empty, adds the trigger that requires `items.cost`, and adds the permission, owner-only.
- **API:** `purchaseCost4dp` is in the item answer only for someone with `items.cost`. Leaving it out of a save keeps the value; `null` clears it. Excel import: one column "Purchase price (excl. VAT)", refused row by row for anyone without `items.cost`.
- **Screens:** the item form shows the field and the profit per unit (sale price without VAT minus purchase price, with its percentage); the item card shows the cost and the profit.
- **Audit:** every change is in the audit log. The audit log can be read by the accountant (`audit.view`), so the cost is visible there; see the open question below.

## Consequences
- Item costs are not shown to anyone else, in lists, exports or screens.
- The sale documents (M4) must store the unit cost on each line when they are issued, and reports must use that stored cost.
- **Open:** hiding purchase prices from the audit log's viewer (the accountant) would need the audit screen and its export to mask the cost fields. Not done; decide with the owner if it matters.
