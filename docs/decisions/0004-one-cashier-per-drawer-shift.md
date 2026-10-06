# 0004 — One cashier per drawer shift

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner |

## Decision
Each cashier has their **own drawer shift** and is **responsible for its over/short**.

## Rules
- **A drawer has at most one open shift, and a cashier has at most one open shift.** The database enforces both.
- **While a shift is open, only its cashier can complete sales, refunds and cash movements on that drawer.** The database checks this too.
- **Supervisors** can approve actions on the drawer (with their PIN) but do not sell on another cashier's shift.
- **Handover:** the first cashier closes their shift (blind count, Z report), then the next cashier opens their own shift with an opening float.
- **Responsibility:** the variance belongs to the shift's cashier. The variance history and alerts on repeated variances are kept per cashier.

## Why
- Clear accountability for cash; no shared-drawer disputes.

## Consequences
- The per-user PIN quick switch is still used, for supervisor approvals and for handovers.
