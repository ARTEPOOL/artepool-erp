# 0017 — Quarterly VAT export package and annual archive

| | |
|---|---|
| **Status** | Accepted (delivered in Phase 2) |
| **Date** | 2026-10-06 |
| **Decided by** | Owner / accountant |
| **Refined by** | [0119](0119-vat-period-archive.md) (2026-11-05): the sales half comes earlier as an automatic PDF archive per VAT tax period; the setting becomes `vat.period_start_month`, `vat.period_months`, `vat.period_effective_from` |

## Decision
- **Every quarter:** an export package in **Excel + PDF** containing:
  - sales invoices (including advance/progress payment invoices)
  - credit notes
  - purchases with input VAT
  - a VAT summary
- **Every year:** an archive file combining all four quarters, organised by date.

## How it works
- **Quarter boundaries are configurable,** because the tax periods assigned by the tax authority may not be calendar quarters (setting `vat.quarter_start_month`).
- **Every export is logged:** who generated it, when, which period, and the SHA-256 fingerprint of each file. It requires permission `data.export`.
- **The database stays the record.** Export files are copies, and can be generated again identically for any closed quarter.
- **Purchases and input VAT** are filled in once P2 purchasing and expenses exist. The P1 data model is already compatible.
