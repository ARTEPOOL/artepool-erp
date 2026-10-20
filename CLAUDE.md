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
- **Invoice format** follows the customer's VAT registration at the POS: not registered → simplified tax invoice; registered → full tax invoice with the customer's TRN. (0010)
- **A4 invoices (INV-)** are full tax invoices for a registered customer (address required) or a named customer with an address on file; the walk-in or a customer without an address gets a simplified one. Nothing is typed on the invoice. Advance invoices and debit notes follow 0010. (0071)
- **Numbering:**
  - `POS-` for POS sales; `INV-` for A4 invoices and advance/progress payment tax invoices. Both are gapless.
  - Credit notes, receipts and the rest each have their own series.
  - Tax documents get their number only at issue. (0011)
- **Discounts** are stored per line (original price, discount, net). Revenue is posted net of discount. (0012)
- **Advance and progress payments:** a payment that does not settle an already-issued tax invoice gets its own tax invoice with VAT. The final invoice deducts earlier payments and their VAT. (0013)
- **Prices:**
  - Each item has one sale price (4 dp) with a "price includes VAT" switch.
  - An inclusive price is split back into net and VAT; an exclusive price has VAT added.
  - Every tax invoice shows net, VAT and total for every customer.
  - Prices live in `md.item_prices` per price level. Only `STANDARD` exists now; a level by customer type can be added later. (0032)
- **VAT categories:** four fixed UAE categories (SR 5%, ZR, EX, OS). Only the owner changes a rate, with a reason; it applies to new documents only. (0033)

**Master data**
- **Excel import:** check first (row-by-row report), then all rows in one transaction or none. (0031)
- **Customer types:** individual / contractor / company (required); the type never changes VAT. (0032)
- **Credit:** customers start as cash (limit 0, on receipt). Credit changes need `customers.credit` and a reason; the database enforces it. (0036)
- **Rules:**
  - Item code: suggested, fixed after creation.
  - Customer phone: required, unique.
  - TRN: 15 digits starting with 100, unique per customers / suppliers.
  - Logo: PNG/JPEG only.
  - Deactivate with a reason, never delete. (0037)
- **Screens:**
  - side menu: Items & stock, Customers, Suppliers, Accounting
  - Settings: Company, VAT & numbering, Lists (0034)

**POS and cash**
- **Oversell** at the POS is allowed only with supervisor approval. It posts an oversell adjustment that the storekeeper reviews. (0003)
- **Shifts:** one cashier per drawer shift. Only that cashier sells on that drawer, and they own the over/short. (0004)
- **Cart removals** before the invoice is issued need no approval. They are always written to the audit log as events. (0005)
- **Shift-close recount:** at most one, with supervisor approval. Both counts are kept. (0006)
- **Hardware:** standard 80 mm ESC/POS printers (Epson TM-T20III / TM-T82 and compatible); the drawer is on the printer's kick port. (0055)
- **Receipt printer modes:** per PC, ESC/POS thermal (RAW, cut, drawer) or any printer through its Windows driver (image at real width, no drawer). The receipt follows the owner's sample: Item / Amount table, a dotted separator between items, a large total, a Paid box. (0070)
- **Blind count:** notes 1000–5, coins 1–0.05, plus "other amount"; exact to the fils. (0056)
- **Cash drop alert** above AED 3,000 (setting); it clears itself once the drawer is back under the limit or the shift is closed. The owner sees the expected cash on "My shift"; everyone else counts blind. (0057, 0080)
- **POS kiosk:** one app; the device kind decides the mode. POS PCs start full screen in an app-level kiosk lock (no closing, watchdog restart; no shell replacement or Assigned Access); exits and unlocks audited and alerted. Per-PC **Kiosk lock** switch on the server (default on; owner only, 2-step step-up + reason; off 15 min / 1 h / until on; owner code on the lock screen = 15 min; off by itself while the owner is signed in on that PC, back at sign-out or screen lock; banner "القفل متوقف"). PIN, shifts and permissions never change with the lock. (0082, 0083, 0089, 0091)
- **POS idle:** the cashier's session stays open; a "Lock screen" button (same cashier resumes with the PIN); owner-only auto-lock, off by default. (0090)
- **Growth:** two cashiers on one POS PC (close the open shift first) or a second POS PC with its own drawer, no redesign. (0087)
- **Stuck shifts:** owner/accountant close a shift stuck on another PC (reason + count; over/short stays the cashier's); the owner moves a re-enrolled PC's drawer to it; a PC with an open shift cannot be revoked. (0069)
- **Over/short** accepted by owner or accountant (posts to 6910); alert after 3 differences above AED 20 within 30 days (settings). (0058)
- **POS discounts/prices** as A4: cashier limit 5% by default, above it a supervisor; any unit-price change needs a supervisor; oversell stays supervisor-approved. (0059)
- **POS returns:** supervisor approval; a credit note linked to the original invoice; stock back; refund from the currently open shift (card as card). (0060)
- **Card:** amount + terminal approval code only; never any card digits. (0061)
- **Receipt** in Arabic and English; cash customer by default, a VAT-registered customer → full invoice with TRN. (0062)
- **Printing:** the POS prints thermal receipts silently. The "Invoices (A4)" section prints through the print dialog. A POS sale can be reprinted in A4 with the same number. (0008)
- **Print designer:** the owner customises print templates (logo, colour, language, optional fields, texts, margins) in Settings → Print designer. Tax-required fields are locked (list per document type in 0064, pending accountant review); seller address on every tax invoice and customer address on full tax invoices are locked, and a full tax invoice is refused without the customer's address. Receipts and statements use the A4 invoice design; the thermal receipt's language is set there too. Templates are versioned; each document stores its template version, but a reprint uses today's design (content unchanged, 0071). No QR code until e-invoicing. The thermal receipt can have its own logo (Print designer → Thermal receipt; empty = the company logo). Logo in the middle on a bilingual A4 document: Arabic details right, logo centre, English left. (0020, 0064, 0067, 0075, 0076)
- **Bank accounts:** several per company (bank, account name, UAE IBAN with checksum, optional SWIFT), owner only, audited; the template chooses which one prints. (0065)
- **Customer PO number:** optional on A4 invoices and quotations; prints only when filled. (0066)
- **Fonts:** GE SS TV for Arabic letters only (screens, A4, receipt); digits and English never use it (it draws Arabic-Indic digits); Tw Cen MT Condensed Extra Bold for English headings only (`--font-heading`); body English and digits stay IBM Plex Sans Arabic. Files in `assets/fonts/`. (0068)

**Security and access**
- **Sign-in:** cashiers use a 4-digit PIN **only on PCs enrolled as POS** (weak PINs refused; 5 wrong → blocked until the owner unblocks). Office PCs always need a password. (0021)
- **Approvals:** every supervisor approval is given with the one-time 6-digit code from the approver's 2-step app (accepted once); only 2-step users approve; 5 wrong codes block that person's approvals (not their sign-in) until the owner unblocks. (0074)
- **Server and remote:** the POS PC is also the server (services under own accounts, ACLs, standard cashier Windows account whose Windows restrictions stay when the kiosk lock is off, UPS reminder). **No remote access in Phase 1:** no VPN, no open router ports, no remote-desktop tools; the laptop works on the shop LAN; keep the design VPN-agnostic (0084 deferred). No cloud database in Phase 1; outbox for a Phase 2 read-only mobile dashboard. (0085, 0088, 0093)
- **First-run setup:** a one-time wizard on the server PC after install (company, owner, 2-step, recovery codes, enroll this PC as POS), locked in the database; console commands are emergency tools. Cashier added in Settings → Users; the laptop enrolled with a code; the PC kind decides the mode. (0092, 0094)
- **Backups:** hourly local + WAL; daily age-encrypted to a dedicated Google Drive account (private key offline); weekly external drive; restore test. Google Drive is connected by choosing the account (PKCE + loopback; the app's Google registration is built into the installation, never typed; code at google.com/device as fallback). (0086, 0095)
- **Screen lock:** per kind of PC, off or after 1–240 idle minutes, in Settings → Devices (owner only); off on every PC at the owner's request; the session still ends after its maximum length. (0079)
- **Owner 2-step:** TOTP, 10 one-time recovery codes, and an audited emergency reset that works only on the server PC. (0022)
- **Passwords:** 10+ characters, common ones refused, no forced symbols or expiry; a change ends the user's other sessions. (0023)
- **Devices:** a 10-minute one-time enrollment code that also proves the server is genuine; the PC then trusts only the ARTÉPOOL CA. (0024)
- **First owner / first PC:** `pnpm owner:create` and `pnpm device:code` on the server PC. (0025)
- **Never deleted:** users are deactivated and devices revoked, always with a reason; revoking a device is final. (0026)
- **Trust this PC:** after the phone code, that PC is remembered (box ticked by default) until the password changes (password alone there; setting 3650 days); on POS PCs only for the owner (0078); ends on a password/2-step change, deactivation, revoke; the owner can end it in Settings → Devices. Enforced in the database. (0027, 0077, 0078)
- **Forgot password:** 2-step users recover it in the app with the phone code + one recovery code; ends all their sessions and trusted PCs. (0028)
- **Last resort:** `pnpm owner:reset-password` on the server PC only — reason required, temporary password shown once, optional 2-step reset if the phone is lost, audited; the owner sees a notice when choosing their own password. (0029)
- **Company details** (name, TRN, address, logo) are edited by the owner only (`system.company.edit` is owner-only); the accountant keeps viewing/verifying/exporting the audit log. (0030)

**Inventory**
- **Cost visibility:** average cost and stock values only for `stock.view_cost` (owner, accountant); storekeeper and cashier see quantities. (0040)
- **Adjustments** need no supervisor's approval (the limit setting is empty; a value turns it back on). (0054, replaces 0041)
- **Opening stock:** once at go-live, owner only (`stock.opening`); empty cost → the item's purchase price. (0042)
- **Item quantity in the item window:** a new stock item's quantity is posted as its opening stock (owner, accountant, storekeeper: `stock.new_item_quantity`); editing shows the current quantity and a change becomes a "Data correction" adjustment (`stock.adjust`, approval above the limit). No cost is typed there: the purchase price is used. The storekeeper manages items. (0053)
- **Labels** for the 2-inch label printer (LV-275, 203 dpi, TSPL):
  - 50 × 30 default, 50 × 25, 40 × 30; no size wider than the roll (`labels.max_width_mm`); content within the printable width (48 mm, per PC).
  - Drawn by the app at printer dots in fixed mm zones: Arabic name (2 lines, shrink, "…"; English optional), EAN/UPC or Code 128 on whole dots with quiet zones, "120.00 درهم" / "AED 120.00", "incl. VAT" when the price includes VAT.
  - Printed silently at exact size (per-PC label printer, offset, test label in Settings → Devices); the print dialog is only a fallback and for A4 sheets; RAW TSPL next. (0043, 0096)
- **Counts** are blind while counting; one warehouse in Phase 1. (0044)

**Sales (A4)**
- **Sections:** Invoices (A4), Quotations and Receipts each have their own side-menu entry. (0045)
- **Cancel / edit an issued A4 invoice:** owner only (`invoices.cancel`, others need the owner's approval), with a reason: a credit note for the whole invoice (stock back, VAT reversed, paid money refunded at once); "edit" then opens a new draft copied from it. Not when a note exists already or earlier payments are deducted. (0072)
- **Cash customers:** an unpaid invoice for a cash customer (or above a credit limit) needs a supervisor's approval (`sales.credit_over_limit`). (0046)
- **Office cash** posts to Cash in safe (1120) by default, set per payment method. (0047)
- **A4 cash on the drawer:** cash taken in the A4 sections by a user with their own shift open on that PC goes into that drawer (shift, expected cash, drawers account), and card taken that way joins the shift's card total; the X/Z report shows POS sales, A4 invoices and total sales (A4 never in the expected cash). (0063)
- **Cheques** count as paid when received; a bounced cheque is reversed (`RVS-`). (0048)
- **Quotations** are valid 15 days by default; converting keeps their prices. (0049)
- **Printing:** M4 uses a default A4 design and stores the template version; the designer screen is M4b. (0050)
- **Customer opening balances:** once at go-live, owner only (`customers.opening`). (0051)
- **Payments** without chosen invoices settle the oldest first; the rest is an advance with its own tax invoice. (0052)

**Reports**
- **Owner dashboard** (side menu → Reports, owner only): total sales, sales without VAT, VAT due (no input VAT until purchases exist), gross profit from the cost stored on each line; period with comparison; daily chart; POS/A4, payment methods, unpaid, per employee; top items/customers; cash in drawers and safe, receivables and overdue, stock value and reorder. (0039, 0081)

**Accounting**
- **Defective returns** are held at cost in "Inventory – defective" until written off. (0015)
- **Periods** are monthly and are locked after close. Nothing is ever deleted. (0016)
- **Fiscal year** runs January–December. Months are kept 3 months ahead. (0035)
- **Chart of accounts and posting map** are provisional and **pending accountant review**; go-live waits for the approval. Account mappings must stay configurable data, never hard-coded. (0018, 0035)
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
| `design/` | Approved UI design reference v2 (simple style): tokens for light and dark, component styles, design system, screens 01–14. Build the client screens to match it. |

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
| Pinned versions (M0) | Node 24, pnpm 10, TypeScript 6.0 (TypeScript 7 is not yet supported by typescript-eslint — revisit), Vitest 5, ESLint 10, Fastify 5, Kysely 0.29, Zod 4, PostgreSQL 18 |
| Tooling | pnpm workspaces, ESLint, Prettier, Stylelint, GitHub Actions (Linux for API/DB; Windows runner for the Tauri build) |
| Releases | Tauri updater signatures, mandatory. No installer code-signing certificate for now (decision 0007). |

## Commands

Run from the repository root. Setup on a new PC: [`docs/runbooks/dev-setup-windows.md`](docs/runbooks/dev-setup-windows.md).

| Task | Command |
|---|---|
| Install dependencies | `pnpm install` |
| Create database roles + dev database (dev PCs only) | `pnpm db:setup` |
| Apply migrations / dry run | `pnpm db:migrate` / `pnpm db:migrate --dry-run` |
| Migration status + checksum verification | `pnpm db:status` |
| Create the next migration file | `pnpm db:new <lower_snake_name>` |
| Regenerate / verify database types (after migrations) | `pnpm db:codegen` / `pnpm db:codegen:check` |
| Lint + formatting + typecheck + translations | `pnpm check` |
| Format all files | `pnpm format` |
| Unit tests / integration tests (real PostgreSQL) / all | `pnpm test:unit` / `pnpm test:integration` / `pnpm test` |
| Screen tests in a real browser (Playwright, Arabic + English, light + dark; real API on a throwaway database) | `pnpm test:e2e` (once: `pnpm --filter @artepool/desktop exec playwright install chromium`) |
| Verify the audit hash chain | `pnpm audit:verify` |
| Backups (decision 0086): the service / one local copy now / restore test / integrity checks / external-drive copy | `pnpm backup:run` / `pnpm backup:once` / `pnpm backup:restore-test` / `pnpm backup:check` / `pnpm backup:offline <folder>` |
| Tamper demonstration (throwaway database) | `pnpm demo:audit-tamper` |
| Create the development master key (`.secrets/`, once per dev PC) | `pnpm dev:secrets` |
| Create the ARTÉPOOL CA + server certificate (HTTPS, TLS 1.3); `--renew-server` for a new server certificate | `pnpm tls:init [--name host] [--ip address]` |
| Run the API in dev mode (HTTPS: `https://localhost:3100/health`, trust `.secrets/tls/ca.crt`) | `pnpm dev:server` |
| Run the screens in a browser (`http://localhost:1420`; the dev server plays the PC's secure side, device file `.secrets/dev-device.json`) | `pnpm dev:desktop:web` |
| Run the Windows app (Tauri; Rust + Microsoft C++ Build Tools needed) / build its installer | `pnpm dev:desktop` / `pnpm build:desktop` |
| Rust tests (the PC's secure side: enrollment, TLS rules, device key; the RAW receipt printer) | `pnpm test:rust` |
| Server console (emergency tools since 0092): first owner / enrollment code / emergency owner 2-step reset / emergency owner password reset (decisions 0022, 0025, 0029) | `pnpm owner:create` / `pnpm device:code` / `pnpm owner:reset-2fa` / `pnpm owner:reset-password` |

Not yet available: `pnpm build:server` (M6.2).

Rules for migrations: one file per change in `db/migrations/NNNN_name.sql`; no `BEGIN`/`COMMIT` inside (the runner wraps each file); every new table gets `sys.add_touch`/`sys.add_stamp`, `audit.enable_for`, `sys.forbid_delete` and explicit grants — `db/tests/privileges.test.ts` fails otherwise; run `pnpm db:codegen` and commit the regenerated types.

## Definition of done (every task)

- [ ] Golden rules respected
- [ ] Tests written and passing
- [ ] Works in Arabic (RTL) and English (LTR)
- [ ] Permissions checked on the server, not only hidden in the UI
- [ ] Audit entries produced for every write
- [ ] Plain-language summary given to the owner, with manual test steps
- [ ] Committed to Git
