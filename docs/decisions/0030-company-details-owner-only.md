# 0030 — Company details are edited by the owner only; the accountant keeps the audit log

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Decided by** | Owner |

## Decision
- **Company details** (name, tax registration number (TRN), address, logo) can be changed by **the owner only**.
  - The permission `system.company.edit` becomes **owner-only**. Like the other owner-only permissions, it cannot be given to any other role, and the permissions screen shows it as "Owner only".
  - It is removed from the default **Accountant** role.
- **The accountant keeps the audit log:**
  - viewing it (`audit.view`);
  - checking the chain (`audit.verify`);
  - exporting it (`audit.export`).

  So the accountant sees **Settings → Audit log** only.

## Why
- Company details are printed on **every tax invoice**. A wrong TRN or name makes the invoices wrong in front of the Federal Tax Authority (priority 3: correct UAE VAT).
- The accountant needs the audit log for reviews and tax audits, but has no need to change the company's identity.

## How it works
- **Migration 0007** removes `system.company.edit` from every non-owner role. It then marks the permission owner-only, so the database refuses to give it to another role (rule from migration 0005).
- **The removal** is a row change, written to the audit log like any other.

## Consequences
- In M2, the Company screen (Settings → Company) is editable by the owner only. Other roles do not see it.
