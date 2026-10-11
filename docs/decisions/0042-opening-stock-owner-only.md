# 0042 — Opening stock: entered once at go-live, posted by the owner only

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-11 |
| **Decided by** | Owner |

## Decision
- **Opening stock** is entered at go-live, by hand or from Excel (check first, then all rows or none — [0031](0031-excel-import-all-or-nothing.md)), with a quantity and a unit cost per item.
- **An empty cost takes the item's purchase price** ([0038](0038-item-purchase-price-owner-only.md)); an item with neither is refused.
- **Only the owner posts opening stock** (new owner-only permission `stock.opening`).
- **Journal entry:** Inventory – sellable 1310 / Opening balance equity 3900 (posting map row 21).

## Why
- Opening stock sets the starting value of the whole inventory and of the owner's equity; it must be one deliberate act by the owner.

## Consequences
- Later increases use normal adjustments (`stock.adjust`), never "opening".
