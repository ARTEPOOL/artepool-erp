# 0060 — POS returns: a credit note, refunded from the open shift

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-13 |
| **Decided by** | Owner |

## Decision
- A **"Return" button** at the POS, with a **supervisor's approval**.
- A return always issues a **credit note linked to the original POS invoice**; the original is never modified.
- Returned goods go back to stock (or to defective stock, as chosen; 0015).
- The money is refunded from the **currently open shift's drawer**, even if the sale was in an earlier shift. **A card sale is refunded as card.**

## Why
- The shift that pays the money out must account for it.

## Consequences
- The refund is a cash movement of the open shift (cash refunds) and is counted in its expected cash.
