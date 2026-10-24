# 0058 — Shift over/short: accepted by the owner or accountant; alert on repeated variances

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-13 |
| **Decided by** | Owner |

## Decision
- A closed shift's over/short is **accepted only by the owner or the accountant** (permission `cash.variance_accept`, which the owner and accountant roles already hold). It then posts to Cash over/short 6910 (posting map row 19). A cashier never accepts their own variance; a shift is accepted once (`cash.variance_acceptances`).
- **Alert:** when the same cashier has a difference above **AED 20** **three times within 30 days**. Both values are settings (`cash.variance_alert_fils`, `cash.variance_alert_repeat_count`, window 30 days in `cash.variance_alert_days`).

## Why
- The cashier owns the over/short (0004); someone else confirms it.

## Consequences
- The variance history per cashier is shown in the shift screens.
