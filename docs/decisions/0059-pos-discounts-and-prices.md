# 0059 — POS discounts and price changes: the same rules as A4 invoices

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-13 |
| **Decided by** | Owner |

## Decision
- **Discounts:** each role has a discount limit; the **cashier's default limit is 5%** (configurable per role and per user). Above the limit a supervisor approves.
- **Unit-price changes always need a supervisor's approval** at the POS (the cashier never holds `sales.price_override`).
- **Selling beyond stock keeps the supervisor's approval** (0003), even though stock adjustments no longer need one (0054).
- Everything is audited.

## Why
- One set of rules for every sale; the owner keeps control of prices.

## Consequences
- The approvals are separate (price, discount, oversell), as for A4 invoices (migration 0018).
