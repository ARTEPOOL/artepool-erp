# 0006 — Shift-close recount: once, with supervisor approval

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner |

## Decision
At shift close, the cashier first does a **blind count**, entering the cash by denomination without seeing the expected amount. The system then shows the over/short. **One recount** is allowed, and only with **supervisor approval** (PIN + reason).

## Rules
- **The recount is done in the supervisor's presence.**
- **Both counts are stored permanently and both are printed on the Z report.** The recount becomes the final count.
- **The database allows at most one recount per shift** and requires the approval.
- **If the final variance is above the register's threshold,** accepting it still needs a separate supervisor approval (permission `cash.variance_accept`).

## Why
- Counting mistakes happen and deserve one correction. Keeping the first count, the approval and the reason makes sure a recount cannot quietly hide a shortage.
