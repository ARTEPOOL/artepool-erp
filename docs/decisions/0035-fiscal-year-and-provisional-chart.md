# 0035 — Fiscal year January–December; the chart of accounts stays provisional until the accountant approves it

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-08 |
| **Decided by** | Owner |

## Decision
- **The fiscal year runs from January to December.**
- **The chart of accounts and the posting map stay provisional and editable** until ARTÉPOOL's accountant approves them ([0018](0018-chart-of-accounts-and-posting-map.md) stays "pending accountant review").
- **Go-live waits for that approval.**

## How it works
- **Periods:** accounting periods are calendar months ([0016](0016-monthly-period-lock.md)). Each period's fiscal year is its calendar year.
- **Creating months:**
  - Migration 0008 creates the months from January of the current year up to 3 months ahead.
  - The server then creates the next months by itself every day, so they always exist 3 months ahead.
- **Editing the chart:** accounts can be added, renamed and deactivated (when not in use). The account used for each event can be changed in Accounting.
- **Every change** is in the audit log, so the accountant can review what was changed before approving.

## Consequences
- Before go-live, the accountant answers the questions in [`accounting/chart-of-accounts.md`](../accounting/chart-of-accounts.md), and decision 0018 is marked approved.
