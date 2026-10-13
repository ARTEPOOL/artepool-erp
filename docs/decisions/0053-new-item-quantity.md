# 0053 — A new item's quantity on hand, entered when the item is created

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-13 |
| **Decided by** | Owner |

## Decision
- When a **new stock item** is created, its **quantity on hand now** can be typed in the same window.
- The **owner, the accountant and the storekeeper** may do it (new permission `stock.new_item_quantity`).
- It is posted as that item's **opening stock**, in the same transaction as the item (Inventory – sellable 1310 / Opening balance equity 3900, as [0042](0042-opening-stock-owner-only.md)); once per item.
- **Cost per unit:** typed only by people who see costs ([0040](0040-stock-cost-visibility.md)); otherwise the item's purchase price is used ([0038](0038-item-purchase-price-owner-only.md)).

## Why
- The owner asked for a simple way to give a new item its current stock without a separate opening-stock document.

## How it works
- The database allows this opening stock only when the item was created in the same transaction, for someone with `stock.new_item_quantity`. Opening stock for existing items stays owner only (`stock.opening`).

## Consequences
- Later changes to the quantity are normal stock adjustments. When purchasing arrives (Phase 2), new goods come in through purchase receipts; the accountant may then review whether this shortcut stays.
