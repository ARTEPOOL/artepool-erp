# 0062 — POS receipt in Arabic and English; cash customer by default

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-13 |
| **Decided by** | Owner |

## Decision
- The thermal receipt shows **Arabic and English together**.
- The POS starts with the **cash customer**; the cashier can select a registered customer. If that customer is **VAT-registered**, the sale is a **full tax invoice with their TRN** automatically (0010); otherwise simplified.

## Why
- One receipt that every customer can read; the invoice format follows the law without the cashier choosing it.

## Consequences
- The language setting allows one language later if wanted.
