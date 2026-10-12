# 0045 — Sales screens: Invoices (A4), Quotations and Receipts are separate sections

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-12 |
| **Decided by** | Owner |

## Decision

**Side menu** (adds to [0034](0034-master-data-screen-placement.md)):

| Entry | Contents |
|---|---|
| **Invoices (A4)** | Tax invoices, payment (advance/progress) invoices, credit and debit notes; create, issue, print, reprint |
| **Quotations** (own section) | Quotations and their revisions; send, accept or reject, convert to an invoice |
| **Receipts** (own section) | Payment receipts (`RCT-`): receive a payment (cash, card, transfer, cheque), its allocation, the payment invoice it creates, print the receipt; refunds (`RFD-`) and reversals (`RVS-`) |

## Why
- The owner wants quotations and receipts each in their own place, not mixed with tax invoices.

## How it works
- Each entry is shown only with its permission (`quotations.manage`, `invoices.view`, `payments.receive`); the server checks again on every call.
- "Receive payment" can also be started from an invoice or a customer; it lands in Receipts.
- Receipts here are **customer** receipts. Money from other sources (paid-in to a drawer, other income) belongs to cash movements (M5) and expenses (Phase 2).

## Consequences
- Design 05 (the A4 section) loses its Quotations tab; the two new sections use the same style.
