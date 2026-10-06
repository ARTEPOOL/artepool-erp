# ARTÉPOOL ERP — Phase 1 Plan

| | |
|---|---|
| **Status** | **Awaiting owner approval.** No application code is written until this plan is approved. |
| **Date** | 2026-10-06 |
| **Scope source** | [`PRD.md`](../PRD.md) v1.1 + [`decisions/`](decisions/README.md) 0001–0019 |
| **Detail** | [`architecture.md`](architecture.md) · [`database-schema.md`](database-schema.md) · [`accounting/`](accounting/posting-map.md) |

---

## 0. The plan in plain words

**What we are building first.** Phase 1 is the core of the system. When it is finished, ARTÉPOOL can:
- sell at the counter (POS) with barcode scanning, a cash drawer and automatic receipts
- issue A4 invoices, quotations and credit notes, and receive advance and progress payments with correct VAT
- track stock, including broken returned goods
- run cashier shifts with a blind cash count
- keep the accounts automatically, with every sale, payment and stock movement written into the books at the moment it happens

It works in Arabic and English, without the internet, on as many PCs as you like.

**How we make sure it is trustworthy.**
- **The database refuses mistakes.** It will not:
  - lose a sale halfway
  - skip or repeat an invoice number
  - let stock go below zero
  - accept an unbalanced accounting entry
  - change an issued invoice
  - delete anything
- **It keeps a tamper-evident diary of every action.** You can see who did what, when and why. Every Z report prints the diary's latest fingerprint, so it cannot be rewritten quietly.
- **It backs itself up continuously and every hour.** An encrypted copy goes off-site every day, and a one-click test proves the backups can be restored.

**In what order.** We build in **8 steps (M0 to M7)**. Each step ends with something you can try yourself, plus a short plain-language note on how to test it by hand:

| Step | What it is |
|---|---|
| M0 | The foundations: database, diary, numbering, safety rules |
| M1 | Logins, user roles, PC registration, Arabic/English screens |
| M2 | Your products, customers, prices and chart of accounts |
| M3 | Stock and the automatic bookkeeping engine |
| M4 | The **Invoices (A4)** section: quotations, invoices, advance payments, credit notes, statements |
| M5 | The **POS** counter, cash drawer and shifts |
| M6 | Backups, restore test, installation on the real PCs |
| M7 | A full "test day" on 2+ tills that must reconcile to the fils, then the accountant's review |

**How we will know it works.**
- Every calculation that touches money, VAT, stock, numbers, permissions or the diary has automatic tests.
- The final test simulates a full day of real sales on two or more tills. It then checks that stock, cash, invoices, VAT, the accounts and the diary all agree exactly.
- A backup is restored to a test database and checked.

**What I need from you, and when:**
- **Now:** create the empty private GitHub repository `artepool-erp` (see §8).
- **Before step M5:** the exact printer, cash drawer, scanner and label printer models, so we can test with the real hardware.
- **Before go-live:** the accountant's approval of the chart of accounts and posting map. Your existing data (items, customers, opening balances) in the Excel templates we provide in step M2.
- **Any time:** the custom screen designs. The screens are built so the design can be applied later without rework.

---

## 1. Phase 1 scope

**Included:**

**Security**
- Users, roles, granular permissions, supervisor approvals (PIN + reason).
- Enrolled PCs, owner 2FA, lockout, idle lock.

**Audit**
- Hash-chained audit log, viewer, verification tool, anchors on Z reports and backups.

**Master data**
- Company profile, items (stock, service, bundle), barcodes, 4-decimal prices.
- Customers with VAT registration and TRN, suppliers, technicians, payment methods, warehouses.
- Lines of business, reason codes, Excel import.

**Inventory**
- Stock ledger with moving-average cost (4 decimals).
- Adjustments, counts, defective bucket held at cost.
- Oversell with approval and storekeeper review.
- Low-stock alerts, labels.

**Invoices (A4) section**
- Quotations → invoices (`INV-`); simplified or full invoice by VAT registration.
- Per-line discounts and VAT.
- Advance/progress payment tax invoices with deduction on the final invoice.
- Credit and debit notes, receipts and refunds, statements of account.
- A4 printing with the print dialog, A4 reprint of POS sales.

**POS section**
- Fast search and scan, split tender, hold/resume.
- Silent thermal receipts (`POS-`).
- Cart removals logged without approval, oversell with approval.

**Cash**
- One cashier per drawer shift, opening float.
- Blind count + one approved recount, X/Z reports.
- Paid-in/out, drops, variance history and alerts, drawer events.

**Accounting core**
- Provisional chart of accounts (revenue by line of business).
- Automatic double-entry postings per the posting map.
- Monthly periods with a simple close/lock screen, read-only journal viewer.

**E-invoicing readiness**
- UUIDs, content hashes, an outbox row for every tax document.

**Operations**
- Backup agent (WAL, hourly, nightly, encrypted off-site, offline drive).
- Restore test, integrity checks, system-health screen.
- Server and client installers, runbooks.

**Arabic/English** throughout, with RTL/LTR, bilingual documents and design tokens.

**Not in Phase 1** (see PRD §13):
- purchasing, expenses, accounting reports, the VAT return and the quarterly export package (P2)
- contracts, visits, service jobs and projects (P3)
- the e-invoice sender (P4 or earlier), WhatsApp/email, promotions, loyalty, standby server

---

## 2. Project structure

```
artepool-erp/
├── CLAUDE.md                       # how we build: rules for every session
├── PRD.md                          # what we build: scope
├── README.md
├── package.json                    # pnpm workspace root: check, test, build, db:* scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .editorconfig  .gitattributes  .gitignore  .nvmrc
├── .github/workflows/
│   ├── ci.yml                      # lint, typecheck, i18n keys, unit + integration tests (PostgreSQL)
│   └── release.yml                 # Windows build, signed update bundle, checksums
│
├── apps/
│   ├── server/                     # API service (Windows service on the Main Server)
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── config/             # typed config; secrets unwrapped with DPAPI
│   │   │   ├── platform/           # cross-cutting building blocks
│   │   │   │   ├── db/             # pool, withBusinessTx(), request context, generated types
│   │   │   │   ├── auth/           # sessions, device auth, password / PIN / TOTP
│   │   │   │   ├── permissions/    # route permission guard, approvals
│   │   │   │   ├── audit/          # explicit events (cart removals, prints, exports), verification
│   │   │   │   ├── numbering/      # gapless series allocation, lock order
│   │   │   │   ├── idempotency/
│   │   │   │   ├── time/           # server time, Dubai business date, clock checks
│   │   │   │   ├── crypto/         # AES-GCM secret box, hashing
│   │   │   │   └── errors/         # error codes (translated on the client)
│   │   │   ├── modules/            # one folder per business module: routes → service → repository
│   │   │   │   ├── system/         # company, settings, series, devices, health, periods screen
│   │   │   │   ├── users/          # users, roles, permissions
│   │   │   │   ├── masterdata/     # items, prices, customers, suppliers, technicians,
│   │   │   │   │                   # payment methods, warehouses, business lines, reason codes
│   │   │   │   ├── inventory/      # movements, adjustments, oversell review, counts, labels
│   │   │   │   ├── sales/          # quotations, invoices, advance invoices, notes, payments, statements
│   │   │   │   ├── pos/            # lookup, sale completion, cart events, held carts
│   │   │   │   ├── cash/           # registers, shifts, counts, recount, cash movements, X/Z
│   │   │   │   ├── ledger/         # posting engine (posting map as data), journals, periods
│   │   │   │   ├── imports/        # Excel templates, validate, commit
│   │   │   │   ├── documents/      # A4 PDF rendering
│   │   │   │   ├── alerts/
│   │   │   │   └── einvoice/       # outbox writer (sender later)
│   │   │   └── jobs/               # scheduler: alerts, periods ahead, integrity checks, anchors
│   │   └── test/
│   │       ├── integration/        # real PostgreSQL, one file per module
│   │       ├── db-rules/           # attempts to break database rules directly
│   │       ├── concurrency/        # parallel sales / numbering / stock races
│   │       ├── posting-map/        # one golden test per posting-map row
│   │       └── acceptance/         # "full day on 2+ terminals" reconciliation
│   │
│   ├── backup-agent/               # separate Windows service
│   │   ├── src/
│   │   └── test/
│   │
│   └── desktop/                    # Tauri 2 client
│       ├── src/
│       │   ├── app/                # shell, routing, providers, RTL/LTR layout, lock screen,
│       │   │                       # "server unreachable" screen
│       │   ├── features/
│       │   │   ├── pos/            # POS section: silent receipts, cart events, oversell, held carts
│       │   │   ├── invoices-a4/    # Invoices (A4) section: invoices, advance payments, credit notes,
│       │   │   │                   # statements, A4 reprint of POS sales, print dialog
│       │   │   ├── cash/           # shifts, blind count, recount, X/Z, paid-in/out, drops
│       │   │   ├── inventory/      # stock, adjustments, counts, oversell review, labels
│       │   │   ├── masterdata/
│       │   │   ├── ledger/         # journal viewer, periods
│       │   │   ├── admin/          # users, roles, devices, settings, system health, backups
│       │   │   └── audit/          # audit viewer, chain verification
│       │   ├── ui/                 # design-system components (React Aria)
│       │   ├── theme/              # tokens.css, themes/
│       │   ├── api/                # typed client, query hooks, error → message mapping
│       │   ├── hardware/           # JS side of printer / drawer / scanner bridge
│       │   └── i18n/
│       ├── src-tauri/              # Rust: RAW thermal printing, drawer kick, Credential Manager,
│       │                           # updater, single instance, optional LAN discovery
│       └── tests/                  # component tests (ar + en), Playwright flows
│
├── packages/
│   ├── shared/
│   │   ├── money/                  # fils + 4-dp helpers, rounding, VAT, discount allocation
│   │   ├── contracts/              # Zod schemas for every API request/response
│   │   ├── permissions/            # permission codes
│   │   └── errors/
│   ├── i18n/
│   │   ├── locales/ar/*.json
│   │   ├── locales/en/*.json
│   │   └── check-keys.ts
│   └── print-templates/            # bilingual HTML/CSS: tax invoice (full / simplified),
│                                   # advance payment invoice, final invoice with deductions,
│                                   # credit note, quotation, statement, thermal receipt, X/Z
│
├── db/
│   ├── migrations/                 # 0001_*.sql … (never edited once applied)
│   ├── test-vectors/               # shared rounding / VAT / costing cases (SQL + TS tests)
│   └── tests/
│
├── tools/
│   ├── migrate/                    # migration runner (checksums, advisory lock, dry run)
│   ├── audit-verify/               # command-line chain verifier
│   └── installer/                  # server setup (PostgreSQL, roles, CA, firewall, services)
│                                   # + client installer
│
└── docs/
    ├── architecture.md
    ├── database-schema.md
    ├── phase-1-plan.md             # this file
    ├── accounting/                 # chart-of-accounts.md, posting-map.md (for the accountant)
    ├── decisions/                  # 0001–0019 + index
    ├── runbooks/                   # install, add a PC, backup / restore, disaster recovery,
    │                               # upgrade, external drive rotation, unsigned installer
    └── user-guide/                 # plain-language guides (ar / en), later
```

**Module rule:** a module owns only its own tables. It calls other modules through their service functions, never by writing their tables. Only the `ledger` posting engine creates journal entries.

---

## 3. Database schema (summary)

The full definition of every column, constraint, trigger and seed is in [`database-schema.md`](database-schema.md). **65 tables in 9 schemas:**

| Schema | Tables | Purpose |
|---|---|---|
| `sys` (9) | schema_migrations, company_profile, settings, branches, document_series, reason_codes, idempotency_keys, alerts, import_batches | System settings, gapless numbering (`POS-`, `INV-`, …), safe retries, alerts |
| `auth` (8) | users, roles, permissions, role_permissions, user_roles, devices, sessions, approvals | Who may do what, from which PC; single-use supervisor approvals |
| `audit` (4) | log, chain_head, anchors, verifications | Tamper-evident diary of every change and event |
| `md` (15) | units, vat_categories, business_lines, item_categories, items, item_barcodes, bundle_components, price_lists, item_prices, customers, suppliers, technicians, payment_methods, warehouses, cash_denominations | Master data; 4-decimal prices; VAT per item; lines of business |
| `inv` (6) | movements, balances, adjustments, adjustment_lines, counts, count_lines | Stock ledger; balances maintained by the database only; oversell review |
| `sales` (9) | quotations, quotation_lines, documents, document_lines, payments, payment_allocations, credit_allocations, opening_balances, held_carts | Invoices (POS and A4), advance/progress payment invoices and deductions, notes, payments |
| `cash` (6) | registers, shifts, counts, count_lines, movements, drawer_events | One cashier per drawer shift, blind count + one recount, cash vouchers |
| `gl` (5) | accounts, account_mappings, periods, journal_entries, journal_lines | Chart of accounts, monthly periods, double-entry postings |
| `ops` (3) | outbox, backup_runs, integrity_runs | E-invoicing queue, backup and integrity records |

---

## 4. Migration order

The detail is in [`database-schema.md` §16](database-schema.md#16-migration-order-phase-1). Migrations follow the build order, so every milestone has a complete, tested database.

| # | Migration | Milestone |
|---|---|---|
| 0001 | extensions, schemas, helper functions | M0 |
| 0002 | audit log + hash chain | M0 |
| 0003 | users, roles, permissions | M0 |
| 0004 | company, settings, branches, numbering series, alerts, imports | M0 |
| 0005 | devices, sessions, approvals, idempotency | M1 |
| 0006 | chart of accounts, mappings, monthly periods | M2 |
| 0007 | master data + reason codes | M2 |
| 0008 | inventory | M3 |
| 0009 | journal entries and lines | M3 |
| 0010 | cash registers, shifts, counts | M4 |
| 0011 | sales documents, payments, allocations | M4 |
| 0012 | e-invoice outbox | M4 |
| 0013 | cash movements, drawer events | M5 |
| 0014 | backup and integrity records | M6 |

---

## 5. Build order

Each milestone follows the `CLAUDE.md` loop:
1. a short task plan, approved by you
2. the build
3. tests
4. a plain-language summary with manual test steps
5. a commit and pull request

A milestone is done only when its tests pass in CI.

### M0 — Foundations

**Delivers:**
- Monorepo scaffold, with lint rules: no literal UI text, no raw colors, logical CSS only.
- CI on GitHub Actions with a PostgreSQL service.
- Migration runner with checksums.
- Migrations 0001–0004.
- `withBusinessTx` and the request context.
- The shared money module and the shared test vectors.
- `sys.next_number`.
- Audit capture, sealing at commit, `audit.verify_chain`, and the `pnpm audit:verify` tool.
- Test harness (a fresh database per test file, cloned from a template).

**Key tests:**
- Rounding vectors pass in both TypeScript and SQL.
- 50 parallel number allocations give no gaps or duplicates, and a failed transaction gives its number back.
- The chain verifies; a tampered row is detected.
- Writes without context are rejected; DELETE is rejected.

**Check by hand:**
- Run `pnpm db:migrate` on an empty database, then `pnpm audit:verify` → "OK".
- Edit an audit row as superuser → the verifier names the broken entry.

### M1 — Security core and app shell

**Delivers:**
- Migration 0005.
- Login with Argon2id, lockout, owner TOTP, PIN user switch, idle lock, sessions with revoke.
- Device enrollment with a one-time code.
- The local CA and TLS 1.3.
- The route permission guard, and approvals (single-use, 5 minutes, different person).
- Desktop shell: login, lock and server-unreachable screens; the language switch flips RTL/LTR; design tokens; update channel.

**Key tests:**
- Every API route declares a permission, and calls without it are refused on the server.
- Lockout, TOTP replay, session expiry and revoke, device revoke.
- Self-approval, expired approvals and reused approvals are all rejected.
- No secrets appear in the logs.
- The API database role cannot delete or alter the audit log.

**Check by hand:**
- Enroll a PC and log in.
- Enter a wrong password 5 times → the account locks.
- Switch to English and back to Arabic → the layout mirrors.
- Unplug the network cable → the "server unreachable" screen appears.

### M2 — Master data and chart of accounts

**Delivers:**
- Migrations 0006–0007.
- Screens for: company profile, settings, items (stock, service, bundle) and barcodes, price lists with 4-decimal prices, customers (VAT registered + TRN), suppliers, technicians, payment methods, warehouse, lines of business, reason codes.
- The provisional chart of accounts and its mappings (editable).
- Excel templates and import with a dry-run report.

**Key tests:**
- TRN rules (15 digits, required when registered).
- Exactly one walk-in customer; barcode uniqueness.
- Arabic letter-variant search.
- Optimistic locking ("changed by someone else").
- An import is all-or-nothing.
- Account mappings cannot point to header or inactive accounts.

**Check by hand:**
- Create an item named "مضخة أرضية" (floor pump); search for "مضخه ارضيه" (ة typed as ه, أ typed as ا) → it is found.
- Import the sample Excel file containing one bad row → you see a clear row-by-row report and nothing is imported.

### M3 — Inventory and the posting engine

**Delivers:**
- Migrations 0008–0009.
- The movement engine: costing in the database, the negative-stock block, 4-dp average cost.
- Opening stock, adjustments, move to defective, write-off, stock counts.
- The oversell adjustment type with review status and the storekeeper review screen.
- Low-stock alerts and barcode labels.
- The table-driven posting engine, monthly periods with a close/lock screen, and the journal viewer.

**Key tests:**
- When the last unit leaves, the exact remaining value leaves with it.
- Stock below zero is rejected by the database.
- 20 parallel requests for the last 5 units → exactly 5 succeed.
- Balances equal the sum of the ledger.
- A golden test for every stock row of the posting map.
- Unbalanced or double posting is rejected.
- Posting into a locked month is rejected.

**Check by hand:**
- Enter opening stock of 10 units at 1.2345 AED → stock value 12.35, average cost 1.2345.
- Remove 3, then the remaining 7 → the average stays 1.2345, and the stock value and the books both end at exactly 0.00.
- Lock last month, then try to post an adjustment dated in it → refused.

### M4 — Invoices (A4) section

**Delivers:**
- Migrations 0010–0012.
- Quotations (with revisions) → invoices (`INV-`).
- Simplified or full format chosen automatically from the customer's VAT registration.
- Per-line price, discount, net and VAT; the document discount spread across lines.
- **"Receive payment":** settles issued invoices; any remainder becomes an **advance/progress payment tax invoice** (`INV-`).
- The **final invoice deducts** earlier payments and their VAT.
- Credit notes (including returns to defective, and notes against advances), debit notes, refunds, reversals (bounced cheque).
- Opening balances, statement of account.
- A4 PDFs with the print dialog; reprint counting and "Copy" marking.
- E-invoice outbox rows.

**Key tests:**
- The 0013 worked example reproduces exactly (VAT 1,500 + 2,000 + 1,500 = 5,000).
- Deductions can never exceed the remaining amount or cross customers.
- A payment on an issued invoice creates no new VAT.
- Every receipt is fully allocated at commit.
- Full ⇔ TRN is enforced by the database.
- `POS-` and `INV-` series cannot be mixed.
- Discount allocation is exact.
- Golden tests for every sales row of the posting map.

**Check by hand:**
- Create a quotation for a pool (100,000 + VAT).
- Receive 31,500 → an INV- payment invoice with VAT 1,500 is printed.
- Receive 42,000 → a second payment invoice is printed.
- Issue the final invoice → it shows both deductions and 31,500 due.

### M5 — POS and cash

**Delivers:**
- Migration 0013.
- The POS screen: keyboard and scanner, split tender, hold/resume.
- **Silent thermal receipts** (simplified or full), the drawer kick only on cash.
- Cart-removal events logged without approval.
- **Oversell with supervisor approval**, which posts the oversell adjustment for review.
- Shifts:
  - one cashier per drawer
  - opening float
  - paid-in/out, drops, drop alerts
  - X report
  - blind count, **one recount with approval**
  - Z report with both counts and the audit anchor
  - variance acceptance, variance history and alerts
- No Sale with permission and reason.
- Opening a POS sale in the A4 section to print it as A4 (same number).

**Key tests:**
- Another user cannot sell on someone else's shift.
- The expected amount is hidden until the count is submitted.
- A second recount is rejected; a recount without approval is rejected.
- Cash on hand equals float + cash sales − refunds ± movements.
- Oversell: no approval → blocked; with approval → adjustment pending and stock never negative.
- Cart events link to the invoice.
- Idempotent retry after a network drop.
- Receipt raster snapshots in ar/en/both.

**Check by hand:**
- Sell an item that shows 0 in stock → you are asked for a supervisor PIN and reason → the sale completes → the storekeeper sees "pending review".
- Close the shift and enter a wrong count → see the variance → recount with a supervisor → both counts appear on the Z report.

**Needs:** the hardware models (printer, drawer, scanner, label printer).

### M6 — Operations

**Delivers:**
- Migration 0014.
- The backup agent: WAL archive, hourly dump, nightly base backup, `age`-encrypted daily off-site upload, external-drive reminders.
- The restore test into `artepool_restore_test`, the nightly integrity checks and the system-health screen.
- The server installer (PostgreSQL configuration, roles, CA and certificates, firewall, services) and the client installer (CA trust, offline WebView2).
- Runbooks.

**Key tests:**
- In CI: dump → restore → all integrity checks pass.
- An off-site file decrypts only with the private key.
- Simulated power loss (process killed mid-sale) → no partial data, and integrity is OK after restart.
- A server clock that goes backwards → writes are refused.

**Check by hand:**
- Install on the real server PC and two client PCs.
- Run "Restore test" from the admin screen → green.
- Pull the network cable during a backup → an alert appears.

### M7 — Acceptance

**Delivers:**
- The full-day simulation on 2+ terminals (§6.3), run on the real hardware.
- Performance measurements.
- A security review.
- The accountant's review of the chart of accounts, the posting map, invoice layouts and the VAT summary.
- A written changelog.

**Done when:** the PRD §13 acceptance criteria are met and the accountant signs off decision 0018.

---

## 6. Test plan

### 6.1 Test levels

| Level | Tool | Runs | What it proves |
|---|---|---|---|
| Unit | Vitest + fast-check | Every commit (CI) | Money, VAT, discount allocation, permission resolution, formatting |
| Shared vectors | JSON cases run by TS and SQL | Every commit | One rounding/costing rule in both places |
| Database rules | Vitest + SQL | Every commit | The database itself refuses bad data, even if the app has a bug |
| Integration | Vitest + real PostgreSQL 18 | Every commit | Each business operation writes exactly the right rows, together |
| Concurrency | Parallel requests | Every commit | No duplicate numbers, no stock races, the chain stays valid |
| Posting map | One golden test per row | Every commit | The books match the approved posting map |
| UI | Component tests (ar + en), Playwright flows | Every commit / nightly | Screens work in RTL and LTR; main flows work end to end |
| Print | Snapshot tests of receipts and PDFs | Every commit | Layouts are bilingual and columns add up |
| Backup | Dump → restore → integrity checks | Nightly CI + monthly on site | Backups really restore |
| Acceptance | Day simulation + reconciliation | M7, and before each release | The P1 acceptance criteria |

### 6.2 Critical test catalogue

| Area | Must-pass cases |
|---|---|
| **Money and VAT** (0009, 0012, 0014) | Rounding half away from zero (positive and negative); 4-dp × quantity → fils; exclusive and inclusive VAT per line (9.99 incl. → VAT 0.48, net 9.51); document discount shares add up exactly and are never negative; document totals = Σ lines; invoice VAT = Σ line VAT; no cash rounding anywhere |
| **Invoice format and numbering** (0010, 0011) | Registered customer → full with TRN; not registered → simplified; the database rejects any mismatch; POS uses `POS-` only, A4 uses `INV-` only; gapless under 50 parallel issues; rolled-back operations consume no number; drafts never numbered |
| **Advance / progress payments** (0013) | Payment not covering an issued invoice → payment invoice with VAT = amount × 5/105; worked example reproduced exactly; deduction ≤ remaining; no cross-customer deduction; payment on an issued invoice → no VAT document; every receipt fully allocated at commit; credit note on an advance; bounced cheque on an advance → credit note created too |
| **Stock** (0003, 0015) | 4-dp average; last unit leaves with exact remaining value; database blocks negative stock; parallel last-unit race; oversell blocked without approval; oversell valued at average → last average → fallback → blocked; review pending → reviewed; bundles deduct components; defective returns at cost to "Inventory – defective"; write-off; balances = Σ movements |
| **Cash and shifts** (0004, 0006) | One open shift per drawer and per cashier; only the shift's cashier can sell; expected hidden until the blind count is submitted; at most one recount, approval required; expected cash formula; variance approval above threshold; Z snapshot immutable with both counts and the anchor; drawer opens only for cash; No Sale needs permission + reason |
| **Cart removals** (0005) | No approval asked; every removal, quantity reduction and clear is in the audit log with cart ID, item, quantity, cashier and server time; queued events are delivered after a short outage; linked to the final invoice |
| **Ledger** (0016, 0018) | Every posting-map row has a golden test; balanced or rejected; double posting rejected; closed/locked month rejected; revenue net of discount (no discount account); business line on revenue and cost lines; AR control = Σ customer ledgers |
| **Security** | Every route has a permission (meta-test); server-side denials; approvals single-use, expiring, not self-approved; lockout; TOTP replay; session and device revoke; no secrets in logs; API role privileges (no DELETE, no audit or balance writes); TLS 1.3 only |
| **Audit** | Every business table has the audit trigger and no-delete guard (meta-test); write without context rejected; chain verifies; tampering detected at the exact entry; anchors match Z reports and backups; prints, reprints (thermal / A4), exports and cart events logged |
| **Printing** (0008) | POS receipt prints without a dialog; A4 opens the print dialog; A4 reprint of a POS sale keeps the same number, increments the print count and is marked "Copy"; every printed row adds up (price × qty − discount = net + VAT) |
| **Arabic / English** | Identical translation keys; no literal text (lint); every screen tested in RTL and LTR; Arabic search variants; Arabic renders on the thermal receipt |
| **Resilience** | Process killed mid-transaction → nothing partial; network drop after commit → retry returns the same result; server clock backwards → writes refused |
| **Performance** (PRD §12) | Barcode/search < 300 ms (95th percentile) with 20,000 items; sale completion < 2 s (95th percentile) with 4 tills selling at once |

### 6.3 Acceptance test: "a full day on 2+ tills"

**Scripted on 2 or more terminals with real hardware:**
- Opening floats.
- 200+ POS sales with cash, card and split tenders, discounts within and above limits, and cart removals.
- 2 oversells with approval.
- Returns: to sellable and to defective.
- A4 work: a quotation, an advance payment, a progress payment, and a final invoice with deductions, for a VAT-registered customer (full invoice with TRN).
- Cash: a refund, a bounced cheque reversal, paid-in/out, a cash drop, an X report.
- A stock count with variances.
- Shift closes with one recount.

**Reconciliation, all automatic and all required to pass:**
1. **Stock:** balances = Σ movements; sample physical count matches; oversells reviewed.
2. **Cash:** for each shift, counted = expected ± the recorded, approved variance.
3. **Invoices:** every series gapless; totals = Σ lines; formats match VAT registration.
4. **VAT:** VAT summary = Σ document VAT = movement on VAT payable (2130); advance VAT counted once.
5. **Accounts:** every document posted exactly once; all entries balanced; AR control = Σ customer statements; customer advances = Σ undeducted payment invoices.
6. **Audit:** the chain verifies end to end; anchors on the Z reports match.
7. **Backup:** the latest backup restores into the test database and steps 1–6 pass there too.

### 6.4 Reviews

- **Security review** at M7: permissions matrix, database privileges, TLS and CA, secrets handling, update signing, logs.
- **Accountant review** at M7, required before go-live:
  - chart of accounts and posting map (0018)
  - invoice, credit note and payment-invoice layouts
  - VAT summary
  - the e-invoicing go-live date (0019)

---

## 7. Risks and how we handle them

| Risk | Mitigation |
|---|---|
| The e-invoicing go-live date arrives before P4 | The outbox and structured documents exist from P1. The sender is a contained module that can be pulled forward. |
| Arabic printing on the chosen thermal printer | Raster printing doesn't depend on the printer's fonts. We test on the real model in M5. |
| Hardware models are late | The hardware layer sits behind one interface; M0–M4 don't depend on it. |
| The accountant changes the chart of accounts or posting map | Everything is mapping data. Changes before go-live need no code; the golden tests are updated with the approved map. |
| Unsigned installers trigger Windows warnings (0007) | Runbook with install steps and checksums. Revisit code signing later. |
| Existing data is messy | Excel templates with a dry-run report from M2. Opening balances and stock are imported through audited documents. |
| Power cuts | UPS on the server; atomic transactions; WAL; a power-loss simulation test. |

---

## 8. Before we start

1. **Create the repository.** On github.com, create an **empty private repository** named `artepool-erp` under `adretaae-ctrl` (no README), and make sure the Claude GitHub App has access to it. I will then push this plan and the decisions there.
2. **Approve this plan,** or tell me what to change.
3. On approval I start with **M0 (Foundations)**, beginning with a short task-level plan for M0 as `CLAUDE.md` requires.
