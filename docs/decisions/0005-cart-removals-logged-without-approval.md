# 0005 — Removing items from a POS cart: no approval, logged silently

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner |

## Decision
Before the invoice is issued, the cashier can **always** remove an item, reduce a quantity or clear the cart. **No approval is needed and no prompt is shown.** Every such action is **logged silently** in the audit trail.

## How it works
- Each cart has an ID. The app sends removal events to the server as they happen (in small batches every few seconds). If the server is briefly unreachable, the events wait in memory and are sent when it is back.
- **Server side:** each event is written to the hash-chained audit log (`event:pos.cart_line_removed`, `event:pos.cart_qty_reduced`, `event:pos.cart_cleared`) with:
  - the item, quantity and price
  - the cashier and device
  - the server time
- The final invoice stores the cart ID, so removals can be linked to the sale that followed (or to no sale).

## Why
- Correcting a cart is normal at the counter. Approvals would slow the queue, while the silent log still lets the owner spot unusual patterns.

## Consequences
- **After** the invoice is issued, nothing can be removed. A return needs a credit note, which requires approval.
- **P2:** a report "cart removals by cashier" is added.
