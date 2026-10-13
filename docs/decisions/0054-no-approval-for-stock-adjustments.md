# 0054 — Stock adjustments need no supervisor's approval

| | |
|---|---|
| **Status** | Accepted (replaces [0041](0041-stock-adjustment-approval-threshold.md)) |
| **Date** | 2026-10-13 |
| **Decided by** | Owner |

## Decision
- Stock adjustments (increase, decrease, write-off), count differences and quantity corrections in the item window **post without a supervisor's approval**, whatever their value.

## Why
- The owner wants the program simple; the approval step adds work without a real benefit for this business today.

## How it works
- The setting `inventory.adjustment_approval_threshold_fils` is **empty** (migration 0021), so the database never asks for an approval. The rule stays in place: putting a value back (in fils, e.g. 50000 = 500.00 AED) turns it on again.
- Every adjustment is still a numbered document with its journal entry, its reason and the person who posted it, in the audit log.
