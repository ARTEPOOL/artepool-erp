# CLAUDE.md — ARTÉPOOL ERP

Read this file and `PRD.md` at the start of every session. `PRD.md` is the source of truth for scope; this file is the source of truth for how we build. Decisions and their reasons are in `docs/decisions/`.

## Project in one paragraph

ARTÉPOOL ERP is an offline-first Windows desktop system for ARTÉPOOL, a swimming pool company in Al Ain, UAE. It covers:

- invoicing and POS
- inventory, and cash drawer and shifts
- accounting
- maintenance contracts, service jobs and construction projects

It runs client–server on the local network: PostgreSQL and the API service on a Main Server PC, and desktop clients on any number of PCs. It supports Arabic and English, with RTL and LTR layouts. It is for internal use only, with no licensing.

## Priorities (when in doubt, follow this order)

1. Data integrity
2. Security
3. Correct UAE VAT
4. Speed and simplicity

## Golden rules — never break these

1. **Money is integers with fixed precision, never floats.**
   - Document amounts and totals are integer **fils**: `BIGINT`, 2 decimals, columns named `*_fils`.
   - Unit prices, unit costs and weighted-average cost use **4-decimal precision**: `BIGINT` = AED × 10,000, columns named `*_4dp`.
   - Round to the fils **only** through the one shared, tested rounding helper (half away from zero).
   - There is **no cash rounding**: totals are exact to the fils.
2. **No hard deletes** of business records. Cancel with reversal documents; deactivate master data with `is_active`.
3. **Posted documents are immutable.** Corrections only via credit/debit notes or reversing journal entries.
4. **One DB transaction per business operation**: sale + stock + payment + journal + audit commit together.
5. **Gapless numbering** per document series, allocated inside the transaction with row locking.
6. **Every write is audited** in the hash-chained audit log (user, device, server time, old/new values, reason).
7. **Clients never talk to PostgreSQL directly.** Only the API does, with a least-privilege role.
8. **Server time only.** Store UTC; display Asia/Dubai.
9. **Stock on hand is derived** from the stock movements ledger, never edited directly. Every movement has a `warehouse_id`.
10. **Every schema change is a numbered migration.** Never edit an applied migration.
11. **No hard-coded UI text.** Every string goes through i18n (`ar`, `en`). Every layout must work in RTL and LTR.
12. **No hard-coded colors, fonts or spacing in components.** Use design tokens; the final custom design will be applied later.
13. **Never weaken security to make something work.** No disabling TLS, no plain-text secrets, no skipping permission checks, no logging passwords or tokens.
14. **Tests are mandatory** for anything touching money, VAT, stock, numbering, permissions or the audit log.

## Business rules quick reference (details in `docs/decisions/`)

**VAT and invoices**
- **VAT** is calculated per line, and the invoice VAT is the sum of the line VAT. It is shown per line and in the total. Every customer pays VAT; the rate comes from the item's VAT category (standard 5%). (0009)
- **Invoice format** follows the customer's VAT registration: not registered → simplified tax invoice; registered → full tax invoice with the customer's TRN. (0010)
- **Numbering:**
  - `POS-` for POS sales; `INV-` for A4 invoices and advance/progress payment tax invoices. Both are gapless.
  - Credit notes, receipts and the rest each have their own series.
  - Tax documents get their number only at issue. (0011)
- **Discounts** are stored per line (original price, discount, net). Revenue is posted net of discount. (0012)
- **Advance and progress payments:** a payment that does not settle an already-issued tax invoice gets its own tax invoice with VAT. The final invoice deducts earlier payments and their VAT. (0013)

**POS and cash**
- **Oversell** at the POS is allowed only with supervisor approval. It posts an oversell adjustment that the storekeeper reviews. (0003)
- **Shifts:** one cashier per drawer shift. Only that cashier sells on that drawer, and they own the over/short. (0004)
- **Cart removals** before the invoice is issued need no approval. They are always written to the audit log as events. (0005)
- **Shift-close recount:** at most one, with supervisor approval. Both counts are kept. (0006)
- **Printing:** the POS prints thermal receipts silently. The "Invoices (A4)" section prints through the print dialog. A POS sale can be reprinted in A4 with the same number. (0008)

**Accounting**
- **Defective returns** are held at cost in "Inventory – defective" until written off. (0015)
- **Periods** are monthly and are locked after close. Nothing is ever deleted. (0016)
- **Chart of accounts and posting map** are provisional and **pending accountant review**. Account mappings must stay configurable data, never hard-coded. (0018)
- **E-invoicing** goes through an accredited service provider API. The ERP stays the system of record. The go-live date is **pending** and lives in the setting `einvoice.mandatory_from`. (0019)

## How to work

- **Plan first.** For any non-trivial task, propose the plan (files, schema changes, tests) and wait for approval before writing code.
- **Small steps.** One feature or fix at a time; run tests; then commit with a clear message.
- **Ask, don't assume,** for anything that affects accounting treatment, VAT, document layout or security. List the question instead of guessing.
- **Explain in plain language.** The owner is not a software engineer. Summarise what changed and why in simple terms, and say how to test it by hand.
- **Never run destructive commands** on a database that may hold real data (drop, truncate, reset) without explicit confirmation.
- Keep `PRD.md` and this file updated when a decision changes. Record decisions in `docs/decisions/`, one short numbered file per decision, and update `docs/decisions/README.md`.

## Key documents

| Document | Purpose |
|---|---|
| `PRD.md` | Scope (what we build) |
| `docs/architecture.md` | How the system works: stack, topology, integrity and security mechanisms |
| `docs/database-schema.md` | Full Phase 1 database schema |
| `docs/phase-1-plan.md` | Project structure, migrations order, build order, test plan |
| `docs/accounting/` | Provisional chart of accounts and posting map (for the accountant) |
| `docs/decisions/` | One file per decision, with its status |

## Tech stack (confirmed — decision 0001)

| Layer | Choice |
|---|---|
| Database | PostgreSQL 18 (≥ 16 compatible), listening on localhost only |
| API | Node.js 24 LTS + TypeScript (strict), Fastify 5, Kysely on node-postgres, Zod contracts, pino logging, Argon2id (`@node-rs/argon2`), TOTP (`otpauth`) |
| API hosting | Windows service (WinSW) on the Main Server; bundled with esbuild |
| Client | Tauri 2 (Rust) + React 19 + TypeScript + Vite; TanStack Query/Router; Zustand (POS cart only); React Aria Components; CSS Modules + design tokens (CSS variables, logical properties); i18next |
| Printing | Thermal receipts: rendered to a bitmap in the app → ESC/POS raster, sent RAW by the Rust layer (silent). A4: server-rendered PDF (pinned headless Chromium) → print dialog. |
| Transport | HTTPS, TLS 1.3 only, private ARTÉPOOL CA with name constraints; enrolled devices |
| Migrations | Numbered plain-SQL files in `db/migrations/`, run by our own runner with checksums |
| Tests | Vitest (unit + integration against a real PostgreSQL test database), fast-check (property tests), Playwright (UI flows, both languages) |
| Tooling | pnpm workspaces, ESLint, Prettier, Stylelint, GitHub Actions (Linux for API/DB; Windows runner for the Tauri build) |
| Releases | Tauri updater signatures, mandatory. No installer code-signing certificate for now (decision 0007). |

## Commands

These are the **planned** commands. They are created in milestone M0 and do not work until the scaffold exists. Update this section if anything changes during M0.

| Task | Command |
|---|---|
| Install dependencies | `pnpm install` |
| Run API in dev mode | `pnpm dev:server` |
| Run desktop app in dev mode | `pnpm dev:desktop` |
| Lint + typecheck + i18n key check | `pnpm check` |
| Unit tests | `pnpm test:unit` |
| Integration tests (real PostgreSQL; needs `TEST_DATABASE_URL`) | `pnpm test:integration` |
| All tests | `pnpm test` |
| Apply migrations | `pnpm db:migrate` |
| Show migration status / verify checksums | `pnpm db:status` |
| Create a new migration file | `pnpm db:new <name>` |
| Verify the audit hash chain | `pnpm audit:verify` |
| Build server bundle | `pnpm build:server` |
| Build Windows installer + signed update | `pnpm build:desktop` |
| Manual backup now | `pnpm backup:run` |
| Restore latest backup to the test database + integrity checks | `pnpm backup:restore-test` |

## Definition of done (every task)

- [ ] Golden rules respected
- [ ] Tests written and passing
- [ ] Works in Arabic (RTL) and English (LTR)
- [ ] Permissions checked on the server, not only hidden in the UI
- [ ] Audit entries produced for every write
- [ ] Plain-language summary given to the owner, with manual test steps
- [ ] Committed to Git
