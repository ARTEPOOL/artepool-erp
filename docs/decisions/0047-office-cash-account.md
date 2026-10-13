# 0047 — Cash received in the office goes to Cash in safe by default

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-12 |
| **Decided by** | Owner |

## Decision
- Cash received in the office (not at a POS drawer) is posted to **Cash in safe (1120)** by default.
- The account is set **per payment method** and can be changed; it is configurable data, part of the chart waiting for the accountant's review ([0018](0018-chart-of-accounts-and-posting-map.md)).

## Why
- Office cash is not in a drawer shift; mixing it with drawer cash would break the shift counts.
