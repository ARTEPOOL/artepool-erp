# 0048 — A cheque counts as paid when received; a bounced cheque is reversed

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-12 |
| **Decided by** | Owner |

## Decision
- A cheque counts as paid on the day it is received; its number, date and bank are stored.
- A bounced cheque is reversed with a reversal (`RVS-`, `payments.reverse`); the invoices it paid become unpaid again. If the cheque had created a payment invoice, that invoice is reversed with a credit note in the same operation.

## Why
- Simple and common practice; post-dated cheque tracking can be added later without changing documents.
