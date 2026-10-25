# 0065 — Company bank accounts, and which one prints

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-14 |
| **Decided by** | Owner |

## Decision
- **Settings → Company details** has a **Bank accounts** list.
- Each account has:
  - **bank name** (required);
  - **account name** (required);
  - **IBAN** (required);
  - **SWIFT/BIC** (optional, 8 or 11 characters).
- More than one account can exist.
- **Only the owner** adds, edits or deactivates them, with the same permission as the company details (`system.company.edit`, decision [0030](0030-company-details-owner-only.md)). Every change is audited.
- Accounts are never deleted; an account is **deactivated** with a reason.
- **IBAN check:** a UAE IBAN only. It is `AE`, then 21 digits (23 characters), and the ISO 13616 checksum (mod 97) must be right. Spaces are allowed when typing and removed when saving. The API and the database both refuse a wrong IBAN.
- **Which account prints** is chosen in the print designer, per template, with "Bank details" turned on ([0064](0064-print-designer-and-locked-fields.md)). Because the choice is part of the template version, a reprint shows the account that was printed originally.

## Why
- Customers pay A4 invoices by transfer; a wrong IBAN on an invoice sends money to the wrong place.

## Consequences
- An account that is deactivated stays on the old template versions that printed it. It cannot be chosen for a new version.
