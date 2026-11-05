# 0120 — Every thermal receipt is also saved as a PDF on the PC

| | |
|---|---|
| **Status** | Accepted (2026-11-05) |
| **Date** | 2026-11-05 |
| **Decided by** | Owner (asked for "save as PDF" on the thermal receipt; chose automatic saving over a button) |
| **Refines** | [0008](0008-printing-pos-silent-a4-section.md), [0070](0070-receipt-printer-modes-and-layout.md) |

## Decision

1. **Automatic.** Whenever the POS produces a thermal receipt (a sale, or a POS return's credit note), a **PDF copy is saved automatically** on that PC. This happens whether or not the printer printed it (a printer that is off or out of paper does not stop the copy).
2. **The PDF is the receipt itself:**
   - the same image the printer gets, at the paper's width (80 mm);
   - the same design, logo and language.
3. **The folder** is the PC's *Public Documents*: `C:\Users\Public\Documents\ARTEPOOL\Receipts\<YYYY-MM>\`. Every Windows account on that PC finds it, the owner's and the cashier's.
4. **File name:** `<number> - DD-MM-YYYY.pdf`, e.g. `POS-000123 - 05-11-2026.pdf` or `CN-000004 - 05-11-2026.pdf`. The date is the document's issue date (Asia/Dubai).
5. **One file per document.**
   - The first receipt makes it.
   - A reprint never overwrites it.
   - A reprint saves the file again only if it is missing; that copy then carries the reprint's "Copy" mark.

## Why

- The owner wants a copy of each receipt without pressing anything: for the records, to send to a customer, or when the printer fails.
- *Public Documents* is the one ordinary folder both Windows accounts on the POS PC can open. The cashier works in their own account (0085), the owner in theirs.

## How it works

- **The PDF:** the app already draws the receipt as an image for the printer. It wraps that same image into a one-page PDF and hands it to the Windows side (the Rust bridge), which writes the file.
- **What the bridge accepts:**
  - only a `.pdf` name in the form above;
  - only inside that folder;
  - written atomically: a temporary file, then a rename.
- **The record stays in the database.** The receipt's print is recorded as today. The local PDF is a convenience copy, and any receipt can be printed again.
- **A failed save never blocks or undoes a sale.** It only shows a short message.

## Consequences

- The folder holds customer names (and TRNs on full tax invoices). Every Windows account on that PC can read it, and the cashier can delete a copy. The database remains the record.
- About 30–60 KB per receipt, a few hundred MB a year at the shop's size. Nothing is deleted automatically.
- Office PCs print A4 through the print dialog, where Windows' own "Microsoft Print to PDF" already saves a PDF.
