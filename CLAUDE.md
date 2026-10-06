# CLAUDE.md — ARTÉPOOL ERP

Read this file and `PRD.md` at the start of every session. `PRD.md` is the source of truth for scope; this file is the source of truth for how we build.

## Project in one paragraph

Offline-first Windows desktop ERP for ARTÉPOOL (swimming pool company, Al Ain, UAE): invoicing, POS, inventory, cash drawer/shifts, accounting, maintenance contracts, service jobs and construction projects. Client–server on the local network: PostgreSQL + API service on a Main Server PC, desktop clients on any number of PCs. Arabic + English, RTL/LTR. Internal use only — no licensing.

## Priorities (when in doubt, follow this order)

1. Data integrity
2. Security
3. Correct UAE VAT
4. Speed and simplicity

## Golden rules — never break these

1. **Money is integer fils** (`BIGINT`). Never use floats for money. Do all money math in integers with one shared, tested rounding helper.
2. **No hard deletes** of business records. Cancel with reversal documents; deactivate master data with `is_active`.
3. **Posted documents are immutable.** Corrections only via credit/debit notes or reversing journal entries.
4. **One DB transaction per business operation** (sale + stock + payment + journal + audit commit together).
5. **Gapless numbering** per document type, allocated inside the transaction with row locking.
6. **Every write is audited** in the hash-chained audit log (user, device, server time, old/new values, reason).
7. **Clients never talk to PostgreSQL directly.** Only the API does, with a least-privilege role.
8. **Server time only.** Store UTC; display Asia/Dubai.
9. **Stock on hand is derived** from the stock movements ledger, never edited directly. Every movement has a `warehouse_id`.
10. **Every schema change is a numbered migration.** Never edit an applied migration.
11. **No hard-coded UI text.** Every string goes through i18n (`ar`, `en`). Every layout must work in RTL and LTR.
12. **No hard-coded colors, fonts or spacing in components.** Use design tokens; the final custom design will be applied later.
13. **Never weaken security to make something work** (no disabling TLS, no plain-text secrets, no skipping permission checks, no logging passwords or tokens).
14. **Tests are mandatory** for anything touching money, VAT, stock, numbering, permissions or the audit log.

## How to work

- **Plan first.** For any non-trivial task, propose the plan (files, schema changes, tests) and wait for approval before writing code.
- **Small steps.** One feature or fix at a time; run tests; then commit with a clear message.
- **Ask, don't assume,** for anything that affects accounting treatment, VAT, document layout or security. List the question instead of guessing.
- **Explain in plain language.** The owner is not a software engineer: summarise what changed and why in simple terms, and say how to test it by hand.
- **Never run destructive commands** on a database that may hold real data (drop, truncate, reset) without explicit confirmation.
- Keep `PRD.md` and this file updated when a decision changes; record decisions in `docs/decisions/` (one short file per decision).

## Tech stack (confirm in the first planning session, then update this section)

- Database: PostgreSQL 16+
- API: TypeScript / Node.js, running as a Windows service on the Main Server
- Client: Tauri 2 + React + TypeScript
- Transport: HTTPS over LAN
- Tests: unit + integration tests against a real PostgreSQL test database

## Commands

_To be filled in once the project is scaffolded (install, dev, test, migrate, build, backup, restore)._

## Definition of done (every task)

- [ ] Golden rules respected
- [ ] Tests written and passing
- [ ] Works in Arabic (RTL) and English (LTR)
- [ ] Permissions checked on the server, not only hidden in the UI
- [ ] Audit entries produced for every write
- [ ] Plain-language summary given to the owner, with manual test steps
- [ ] Committed to Git
