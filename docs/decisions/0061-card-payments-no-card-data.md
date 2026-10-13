# 0061 — Card payments: amount and approval code only

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-13 |
| **Decided by** | Owner |

## Decision
- The card terminal is separate. The cashier picks "Card" and types the **amount and the approval code** from the terminal slip.
- **No card number is ever stored, not even the last 4 digits.**

## Why
- Card data never enters the system, so there is nothing to protect or leak.

## Consequences
- The approval code is stored as the payment's reference.
