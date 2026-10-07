# Decision records

There is one short file per decision, numbered in order.

- **Never edit an accepted decision to change it.** Add a new decision that supersedes it, and update the status of the old one.
- **Keep `PRD.md` and `CLAUDE.md` in step** with every decision.

| # | Decision | Status |
|---|---|---|
| [0001](0001-tech-stack.md) | Tech stack | Accepted |
| [0002](0002-separate-private-repository.md) | Separate private repository | Accepted |
| [0003](0003-pos-oversell-with-approval.md) | POS out-of-stock: sell with supervisor approval | Accepted |
| [0004](0004-one-cashier-per-drawer-shift.md) | One cashier per drawer shift | Accepted |
| [0005](0005-cart-removals-logged-without-approval.md) | Cart removals: no approval, logged silently | Accepted |
| [0006](0006-one-recount-with-supervisor-approval.md) | Shift-close recount: once, with supervisor approval | Accepted |
| [0007](0007-no-code-signing-certificate-for-now.md) | No code-signing certificate for now | Accepted (revisit later) |
| [0008](0008-printing-pos-silent-a4-section.md) | Printing: silent POS receipts, separate A4 section | Accepted |
| [0009](0009-vat-per-line.md) | VAT calculated per line | Accepted |
| [0010](0010-invoice-format-by-vat-registration.md) | Invoice format follows VAT registration | Accepted |
| [0011](0011-document-numbering-series.md) | Document numbering series (POS- / INV- …) | Accepted (other prefixes approved as defaults) |
| [0012](0012-discounts-net-revenue-per-line.md) | Discounts: revenue net, stored per line | Accepted |
| [0013](0013-advance-and-progress-payments-vat.md) | Advance and progress payments: VAT on receipt | Accepted |
| [0014](0014-money-precision-and-rounding.md) | Money precision (fils + 4 decimals) and rounding | Accepted |
| [0015](0015-defective-returns-held-at-cost.md) | Defective returns held at cost | Accepted |
| [0016](0016-monthly-period-lock.md) | Monthly period lock; never delete | Accepted |
| [0017](0017-quarterly-vat-export-and-annual-archive.md) | Quarterly VAT export package and annual archive | Accepted (Phase 2) |
| [0018](0018-chart-of-accounts-and-posting-map.md) | Chart of accounts and posting map | **Pending accountant review** |
| [0019](0019-einvoicing-via-accredited-provider.md) | E-invoicing via accredited service provider | Approach accepted; **go-live date pending** |
| [0020](0020-print-template-designer.md) | Print template designer (versioned, locked tax fields) | Accepted |
| [0021](0021-cashier-pin-sign-in-on-pos-pcs.md) | Cashier PIN sign-in only on POS PCs | Accepted |
| [0022](0022-owner-2-step-recovery.md) | Owner 2-step code: recovery codes and server-only emergency reset | Accepted |
| [0023](0023-password-rules.md) | Password rules (10+ characters, common ones refused, no expiry) | Accepted |
| [0024](0024-device-enrollment-proves-the-server.md) | Device enrollment: 10-minute one-time code that also proves the server | Accepted |
| [0025](0025-first-owner-and-pc-from-server-commands.md) | First owner and first PC created by server commands | Accepted |
| [0026](0026-users-and-devices-never-deleted.md) | Users and devices never deleted: deactivate or revoke with a reason | Accepted |

## Template

```markdown
# NNNN — Title

| | |
|---|---|
| **Status** | Proposed / Accepted / Pending accountant review / Superseded by NNNN |
| **Date** | YYYY-MM-DD |
| **Decided by** | Owner / accountant |

## Decision
## Why
## How it works
## Consequences
```
