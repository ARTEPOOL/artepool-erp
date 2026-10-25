# 0043 — Barcode labels: a list of sizes, custom sizes, through the print dialog

| | |
|---|---|
| **Status** | Accepted; sizes, layout and printing updated by [0096](0096-barcode-labels-2-inch-printer.md) |
| **Date** | 2026-10-11 |
| **Decided by** | Owner |

## Decision
- **Label sizes offered (mm):** 25 × 15, 30 × 20, 38 × 25, 40 × 30, 50 × 25, 50 × 30, 58 × 40, 100 × 50, and **A4 label sheets** filled with labels of a chosen size.
- **Custom sizes:** the owner can add a size (width × height in mm, with a name); it stays in the list. Sizes are deactivated, never deleted.
- **Content fits the size:** the barcode always; the name and the price (with VAT, optional) when there is room.
- **Printing goes through the normal print dialog** for now (a label printer installed in Windows, or A4 sheets). Silent printing to a dedicated label printer comes with the hardware list before the POS (M5).

## Why
- The printer model is not chosen yet; the print dialog works with any printer.

## Consequences
- Label sizes are master data (`md.label_sizes`), audited like the other lists, under Settings → Lists.
