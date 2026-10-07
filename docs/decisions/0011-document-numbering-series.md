# 0011 — Document numbering series

| | |
|---|---|
| **Status** | Accepted. The owner decided the two invoice series and approved the other prefixes as defaults (2026-10-07); they can be changed before go-live. |
| **Date** | 2026-10-06 |
| **Decided by** | Owner |

## Decision
**Two separate gapless invoice series:**
- **`POS-`** for POS sales
- **`INV-`** for A4 invoices, including advance and progress payment tax invoices

**Default series for other documents:**

| Series | Used for |
|---|---|
| `CN-` | Credit notes (both sections) |
| `DN-` | Debit notes |
| `Q-` | Quotations |
| `RCT-` | Receipts |
| `RFD-` | Refunds |
| `RVS-` | Payment reversals (e.g. bounced cheque) |
| `CV-` | Cash vouchers (paid-in / paid-out / drops) |
| `Z-` | Shifts |
| `ADJ-` | Stock adjustments |
| `CNT-` | Stock counts |
| `JV-` | Journal entries |

## Rules
- **Format:** prefix + 6 digits (for example `POS-000123`). Numbering is continuous, with no yearly reset.
- **Old system:** a starting number can be set to continue an old system's numbering.
- **When numbers are given:**
  - Tax documents get their number **only at issue**, so discarded drafts never use one.
  - Quotations are numbered at first save.
- **Gapless:** a number is taken inside the same database transaction as the document. If anything fails, the number is not used.
- **POS invoices** must use the POS series, and A4 invoices the INV series (checked by the database).
