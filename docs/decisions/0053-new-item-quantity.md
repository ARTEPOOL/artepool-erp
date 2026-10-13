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
- **Cost per unit:** not typed in the item window; the item's purchase price is used ([0038](0038-item-purchase-price-owner-only.md)). An item without one is refused with a clear message.
- **The storekeeper adds and edits items** (`items.manage` added to the role, migration 0020); prices and the purchase price keep their own permissions.
- **Editing an item** also shows its current quantity. A change is posted as a stock adjustment ("Data correction") from the quantity that was shown, in the same transaction; if the stock moved meanwhile, the change is refused.

## Why
- The owner asked for a simple way to give a new item its current stock without a separate opening-stock document.

## How it works
- The database allows this opening stock only when the item was created in the same transaction, for someone with `stock.new_item_quantity`. Opening stock for existing items stays owner only (`stock.opening`).

## Consequences
- Later changes to the quantity are normal stock adjustments. When purchasing arrives (Phase 2), new goods come in through purchase receipts; the accountant may then review whether this shortcut stays.
