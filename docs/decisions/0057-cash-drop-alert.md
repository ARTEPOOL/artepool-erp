# 0057 — Cash drop alert above AED 3,000

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-13 |
| **Decided by** | Owner |

## Decision
- When the cash in a drawer exceeds **AED 3,000**, the POS shows an alert asking for a cash drop to the safe.
- The amount is a setting (`cash.drop_alert_fils`).

## Why
- Less cash in the drawer means less risk.

## Consequences
- A drop moves cash from the drawer (1110) to the safe (1120), posting map row 18.
