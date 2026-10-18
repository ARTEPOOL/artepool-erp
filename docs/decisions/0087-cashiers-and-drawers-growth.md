# 0087 — One cashier now; two cashiers on one PC and a second POS PC later, without redesign

| | |
|---|---|
| **Status** | Proposed — waiting for the owner's approval |
| **Date** | 2026-10-18 |
| **Decided by** | Owner (requirements); details proposed |

## Decision
- **Now:** one cashier on one POS PC with one drawer.
- **Already supported later, with no change to the design:**
  - **two cashiers on the same POS PC:** each with their own PIN and their own shift; the open shift must be closed before another cashier opens one on that drawer (0004, existing rule: one open shift per drawer, only its cashier sells on it). Switching cashier = sign out, the other signs in with their PIN.
  - **a second POS PC:** enrolled as POS, it gets its own drawer and its own shifts (registers are per PC; stuck shifts and moving a drawer, 0069).
- Kiosk mode (0082) applies to every POS PC; the server stays on one PC (0085).

## Why
To grow from one cashier to more without touching the database or the rules.
