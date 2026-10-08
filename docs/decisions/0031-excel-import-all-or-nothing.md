# 0031 — Excel import: all or nothing, after a full check

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-08 |
| **Decided by** | Owner |

## Decision
- **An import happens in two steps: Check, then Import.**
- **Check** reads the whole file and saves nothing. It shows a report with **every** problem, by row and column. For example: "Row 14, TRN: must be 15 digits starting with 100".
- **Import** is possible only when the check found no problem. It saves **all rows in one transaction, or none**.
- The design's "import the good rows, skip the bad ones" is **not** used.

## Why
- **No half-imported data.** A partly imported file is hard to finish: you cannot easily tell which rows went in.
- **No duplicates on a second try.** Importing the same file again is reported as "already exists" and imports nothing.
- **Data integrity is priority 1.**

## How it works
- **Templates** (Excel, with Arabic and English headers):
  - items with their price
  - price updates for existing items
  - customers
  - suppliers

  Opening stock comes in M3, and opening balances in M4.
- **The check:**
  - applies the same rules as the screens and the database
  - checks duplicates inside the file and against existing records
  - is recorded in `sys.import_batches` (validated or rejected), with its error report
- **The import:**
  - works only on a file whose fingerprint (SHA-256) matches the checked one; a changed file must be checked again
  - is one database transaction, with every row in the audit log
- **Limits:** `.xlsx` only, at most 5 MB and 5,000 rows per file.
- **Permissions:** `data.import`, plus the list's own permission (for example `items.manage`).

## Consequences
- The import dialogs in designs 07 and 14 show the check report instead of a "skipped rows" count.
- You fix the problems in Excel, then check and import again.
