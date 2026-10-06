# 0008 — Printing: silent POS receipts, separate "Invoices (A4)" section

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner |

## Decision
- **POS section:** the thermal receipt (80 mm) prints **automatically and silently** after each completed sale or refund. No print dialog appears.
- **"Invoices (A4)" section:** a completely separate area of the app for A4 invoices, advance/progress payment invoices, credit notes and statements. Printing **shows the Windows print dialog**.
- **A4 reprint of a POS sale:** when a customer asks, any POS sale can be opened in the Invoices (A4) section and printed in A4 format. It is the **same document with the same number** (`POS-…`). Nothing is re-issued.

## How it works
- **Thermal receipts** are rendered as an image in the app and sent straight to the receipt printer. Arabic always prints correctly this way.
- **A4 documents** are rendered as a PDF by the server from bilingual templates, then shown in the print dialog.
- **Every print is counted** (`print_count`) and logged in the audit trail with the format (thermal or A4).
- **Reprint marking:** by default, every print after the first is marked **"Copy / نسخة"** (setting `print.mark_reprints_as_copy`, on by default). This can be switched off if the accountant prefers.

## Consequences
- **A simplified invoice can never be edited into a full one.** If a VAT-registered customer was sold to on a simplified invoice and later needs a full tax invoice with their TRN, issue a credit note for the original and then a new full invoice.
