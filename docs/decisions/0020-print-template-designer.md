# 0020 — Print template designer

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Decided by** | Owner |

## Decision
- The owner can **customise the layout of every printed document** from a "Print designer" screen in Settings, with a live preview (design reference: `design/screens/11-print-designer.html`).
- Covered templates in Phase 1: A4 tax invoice, quotation, credit note, and the 80 mm thermal receipt. The Z report and barcode labels use the same mechanism and are added with their milestones.
- The designer ships with the printing work in Phase 1, not later.

## What can be changed
- **Logo:** upload, position (beside the seller details, centred, flipped) and size.
- **Main colour** for titles, the table header and the total (A4 only; thermal is black and white).
- **Language of the printout:** Arabic + English, Arabic only, or English only — independent of the user's screen language.
- **Text size** (small, normal, large).
- **Optional fields** on or off: logo, address, phone and email, welcome line, customer address, PO number, item code, amount in words, bank details, terms and notes, received-by and signature, cashier name, QR code.
- **Texts:** welcome line, terms and notes, footer.
- **Paper:** A4 margins (narrow, normal, wide); thermal width 80 mm or 58 mm.

## What cannot be changed (locked)
Fields required on a UAE tax document are always printed and cannot be hidden: the document title and type, the seller's name and TRN, the document number and dates, the customer's TRN on a full tax invoice, the VAT per line and the VAT total in AED. The full list is confirmed with the accountant (decision 0010).

## Rules
- **Only the owner** (permission `print_templates.manage`) can change templates.
- **Templates are versioned and immutable.** Saving creates a new version; old versions are never edited or deleted (golden rules 2 and 3).
- **Every issued document stores the template version it was issued with.** A reprint, including years later, uses that version, so it looks exactly like the original (plus the "Copy" mark, decision 0008).
- Every save is written to the audit log with the changes.
- Templates are data (JSON settings + uploaded logo), not code. The A4 PDF renderer and the thermal bitmap renderer both read the same template version.
- A "Restore default" action creates a new version from the built-in default.
