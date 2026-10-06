# 0003 — POS out-of-stock: sell with supervisor approval

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner |

## Decision
When the cashier sells more than the system shows in stock, the sale is **allowed with supervisor approval** (supervisor PIN + reason). The system posts an **oversell adjustment** for the storekeeper to review.

## How it works
1. The POS sees that the quantity on hand is not enough. It asks for a supervisor approval (permission `pos.oversell`).
2. In the **same transaction** as the sale, the system posts a stock adjustment of kind `oversell` (number `ADJ-…`). It adds only the missing quantity, valued at:
   - the item's current weighted-average cost
   - or, if there is none, its last known average cost
   - or, if there is none, the item's fallback cost

   If no cost is known at all, the sale is blocked with a clear message.
3. The sale then deducts the stock normally. **Stock in the database never goes negative.**
4. The adjustment is marked **"pending review"** and the storekeeper gets an alert. The storekeeper marks it reviewed with a note (permission `stock.oversell_review`). If the physical stock really differs, they correct it with a normal count or adjustment.

## Why
- Never losing a sale at the counter, while keeping stock quantities and costs always well-defined and every oversell visible and traceable.

## Consequences
- The setting `pos.out_of_stock_mode` defaults to `allow_with_approval`.
- "Pending oversell reviews" appears in alerts and, from P2, on the owner dashboard.
