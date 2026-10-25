# 0066 — Customer PO number on A4 invoices and quotations

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-14 |
| **Decided by** | Owner |

## Decision
- A4 invoices and quotations have an optional field, **"Customer PO number"**: up to 50 characters, typed freely.
- It **prints only when filled** (and when the template's "PO number" option is on).
- Converting a quotation to an invoice keeps the PO number.
- Like every other field, it is fixed once the invoice is issued (golden rule 3).
