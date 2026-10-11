# 0034 — Where the master-data screens go

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-08 |
| **Decided by** | Owner |

## Decision

**Side menu:**

| Entry | Contents |
|---|---|
| Items & stock | Design 07 |
| Customers | Design 14 |
| **Suppliers** (new) | Same style as Customers |
| **Accounting** (new) | Chart of accounts and the account used for each event. Journal entries are added in M3. |

**Settings:**

| Section | Contents |
|---|---|
| Company | Owner only ([0030](0030-company-details-owner-only.md)) |
| VAT & numbering | Numbering series, accounting periods, e-invoicing status |
| **Lists** (new) | Units, item categories, VAT categories, payment methods, warehouses, technicians, lines of business, reason codes |

## Why
- Items, customers, suppliers and the accounts are used every day, so they get their own entry in the side menu.
- The lists change rarely, so they sit in Settings next to the other setup screens.

## How it works
- **Who sees what:** every entry and section is shown only to people with its permission, and the server checks the permission again on every call.
- **Look:** the new screens use the same style as the approved designs, because the design has no screen for them.

## Consequences
- The Settings design (13) gains a "Lists" section.
- VAT categories move from "VAT & numbering" to "Lists".
