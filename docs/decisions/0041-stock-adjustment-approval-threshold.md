# 0041 — Adjustments above 500.00 AED need a supervisor's approval

| | |
|---|---|
| **Status** | Replaced by [0054](0054-no-approval-for-stock-adjustments.md) (2026-10-13) |
| **Date** | 2026-10-11 |
| **Decided by** | Owner |

## Decision
- **An adjustment or a count difference worth more than 500.00 AED** (absolute value, at average cost) needs a supervisor's approval (`stock.adjust_over_threshold`, a one-time approval like the other approvable permissions).
- The threshold is the setting `inventory.adjustment_approval_threshold_fils` (default `50000`), which the owner can change.

## Why
- Small corrections should be quick; large ones should never happen without a second person.

## How it works
- The server values the adjustment before posting and asks for the approval when needed; the approval is stored on the document and in the audit log.

## Consequences
- The storekeeper may not see the value (0040); the screen only says that an approval is needed.
