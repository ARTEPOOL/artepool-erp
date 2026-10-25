# 0075 — The thermal receipt can have its own logo

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-17 |
| **Decided by** | Owner |
| **Related** | [0064](0064-print-designer-and-locked-fields.md), [0070](0070-receipt-printer-modes-and-layout.md) |

## Decision
- In Settings → Print designer → Thermal receipt, the owner can upload **a logo used only on the thermal receipt**.
- With no receipt logo, the receipt prints the company logo (Settings → Company), as before. "Use the company logo" removes the receipt logo.
- A4 invoices, quotations, receipts and statements always keep the company logo.

## Why
The thermal printer prints in black and white at 80 mm. A colour logo that looks good on A4 often prints badly there; the owner wants a simple black logo on the receipt without changing the A4 one.

## How it works
- One row in `sys.receipt_logo` (migration 0029): PNG or JPEG up to 512 KB, the file's content is checked, not only its name.
- Only `print_templates.manage` (owner) changes it, enforced in the database; every change is audited (the image itself is redacted from the audit values).
- `GET /api/v1/print-templates/receipt-logo` returns the logo the receipt prints and whether it is its own; `PUT` sets or removes it.

## Consequences
- The receipt's "Logo" field still switches the logo on or off; the receipt logo only chooses which image prints.
