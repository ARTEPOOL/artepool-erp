# 0119 — An automatic PDF archive per VAT tax period, with a VAT summary at period end

| | |
|---|---|
| **Status** | Accepted as a requirement (owner, 2026-11-05). The detailed plan is proposed: [`milestones/vat-period-archive.md`](../milestones/vat-period-archive.md), with four open questions (reprint design, POS file format, cashier access, timing). The VAT points (which date decides the period, credit notes in VAT201, retention) are **pending accountant review**. |
| **Date** | 2026-11-05 |
| **Decided by** | Owner |
| **Changes** | [0017](0017-quarterly-vat-export-and-annual-archive.md): its sales half comes earlier, and its planned setting `vat.quarter_start_month` becomes the three settings below. Possibly [0071](0071-a4-invoices-full-and-reprints-current-design.md) (question 1). PRD §9.9, §9.10, §10.3, §13. |

## Decision

1. **Setting** (owner only, with a reason, audited): the **VAT tax period start month**, as shown in EmaraTax / the VAT certificate, and the **frequency** (quarterly by default, monthly as an option).
   - The FTA gives each business its own staggered quarter, e.g. Sep–Nov or Oct–Dec.
   - A change applies from a period with no archived document yet; folders already made never move.
2. **A folder per tax period**, named `VAT DD-MM-YYYY TO DD-MM-YYYY` (e.g. `VAT 01-09-2026 TO 30-11-2026`), created with the period's first sales tax document (Asia/Dubai dates).
3. **Every sales tax document is saved there as a PDF automatically:**
   - POS invoices, A4 invoices, advance/progress payment invoices, credit notes and debit notes;
   - in the subfolders `POS`, `A4`, `Credit notes`, `Debit notes`;
   - named `<number> - DD-MM-YYYY.pdf`;
   - rendered from the document's stored data and stored design version, so a file always matches a reprint;
   - the document's VAT date decides its period. Proposed: the issue date, the same date the books use (pending accountant).
4. **At period end, a "VAT summary" PDF + Excel** in the folder:
   - totals per document type;
   - net and VAT per tax category;
   - credit notes deducted;
   - the figures mapped to the VAT201 boxes (box 1a, Abu Dhabi, for ARTÉPOOL, taken from the company's emirate);
   - every document number, checked to have no gaps.
5. **Location:** a protected data folder on the server PC; the cashier can never delete or change a file. It is included in the local and encrypted Google Drive backups.
6. **Never blocks a sale:**
   - a background queue with retries does the work;
   - System health shows missing PDFs, with **"Regenerate"**;
   - the owner and the accountant have **"Open VAT folder"** (an archive screen in the app, on any PC) and **"Export period to USB / ZIP"**.
7. **Tests:**
   - period boundaries and staggered quarters;
   - Dubai midnight;
   - every document type;
   - no gaps;
   - the PDF identical to a reprint;
   - the cashier cannot delete files.

## Why

- The VAT201 return is filed with figures only. But every sales invoice of the period must be ready, reconciled and kept for an FTA audit.
- Doing it automatically, as the documents are issued, means nothing has to be collected, printed or scanned at the end of a quarter.
- The accountant gets the whole period, with its summary, in one step.

## How it works

- **Documents are queued in the transaction that issues them,** and a background worker writes the PDFs. Each file's SHA-256 is recorded, and a nightly check finds a missing or changed file.
- **The database stays the record** (as 0017 says): every file can be regenerated exactly from the stored data and design version.
- **The PDF of a POS sale** uses the A4 layout of its A4 reprint (proposed; question 2). It never counts as a print and never carries the "Copy" mark.
- **Input VAT (VAT201 boxes 9–11)** stays empty until Phase 2 adds purchases. P2 then fills it, and adds 0017's annual file, to the same folders.

## Consequences

- About 90 KB per PDF: at 50 documents a day, roughly 400 MB a quarter on the server PC and on Google Drive. The Drive account may need more space after a few years.
- The rehearsal day of M7 produces test files. They go with the rehearsal data when the shop starts from a clean database (*delete data*).
- When e-invoicing comes (before 1 July 2027), its XML files can join the same period folders.
