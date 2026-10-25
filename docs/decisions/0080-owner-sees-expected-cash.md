# 0080 — The owner sees the expected cash on "My shift"; drop alerts clear themselves

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-18 |
| **Decided by** | Owner |
| **Related** | [0006](0006-one-recount-with-supervisor-approval.md), [0057](0057-cash-drop-alert.md) |

## Decision
- On **My shift**, the owner sees "Cash expected in the drawer now" all the time, for their own open shift.
- Everyone else keeps counting blind: a cashier never sees the expected cash before the count.
- A "drawer holds more cash than the limit" alert shows only while it is still true: its shift is open and the drawer still holds more than the alert amount (AED 3,000 by default). After a transfer to the safe that brings it below, or once the shift is closed, it disappears by itself.

## Why
The owner wants to know at a glance what the drawer should hold. Old alerts stayed on the list after the cash had already been moved or the shift closed, for amounts like AED 360.

## How it works
- `GET /api/v1/pos/state` returns `expectedCashFils` only when the signed-in user is the owner (`auth.is_owner`), else null.
- The cash alerts list re-checks every drop alert against the shift's status and current expected cash. Nothing is deleted.
