# ARTÉPOOL ERP — Architecture

| | |
|---|---|
| **Status** | Stack accepted ([0001](decisions/0001-tech-stack.md)). Detailed design approved with the Phase 1 plan (2026-10-07). |
| **Date** | 2026-10-06 |
| **Related** | [`database-schema.md`](database-schema.md) · [`phase-1-plan.md`](phase-1-plan.md) · [`decisions/`](decisions/README.md) · [`accounting/`](accounting/posting-map.md) |

---

## 0. In plain words

- **One Main Server PC** runs the database (PostgreSQL) and a background program, the **API service**. Every other PC runs the **ARTÉPOOL desktop app**, which talks only to the API, over the office network, always encrypted.
- **The API is the gatekeeper.** It checks who you are and what you may do, does the calculations, and saves each business action in one all-or-nothing step. For a sale, that step covers the invoice, stock, payment, accounting entry and audit record together.
- **The database is a second gatekeeper.** It refuses bad data even if the app has a bug: deletions, edits to issued invoices, unbalanced accounting entries, postings into a locked month, negative stock, and writes by an unknown user.
- **Every change is recorded in a tamper-evident audit log.** Each entry carries a fingerprint chained to the previous one, and every Z report prints the latest fingerprint.
- **Backups:**
  - every change is saved continuously
  - an hourly copy goes to a second PC or drive
  - a daily encrypted copy goes off-site
  - an external drive that stays disconnected protects against ransomware
  - a one-click restore test proves the backups work

---

## 1. Tech stack (accepted)

| Layer | Choice | Why |
|---|---|---|
| Database | **PostgreSQL 18** (≥ 16 compatible) | Strong transactions, row locks, roles, WAL + point-in-time recovery. Built-in `uuidv7()`. |
| API runtime | **Node.js 24 LTS** + **TypeScript** (strict) | Supported until April 2028. One language for the server and the UI. |
| API framework | **Fastify 5** | Fast and small, with schema validation. |
| Database access | **Kysely** on **node-postgres** | Type-safe SQL. Explicit transactions and row locks; no ORM magic. Types generated from the real database. |
| API contract | **Zod** schemas shared by server and app | One definition; OpenAPI generated from it. |
| Migrations | Numbered **plain-SQL** files + our runner with checksums | Refuses to run if an applied file was edited. |
| Passwords / PINs | **Argon2id** (`@node-rs/argon2`) | Prebuilt for Windows. |
| Owner 2FA | **TOTP** (`otpauth`) | Works offline. |
| A4 PDFs | Bilingual HTML/CSS templates → **pinned headless Chromium** on the server | Correct Arabic shaping; one template for preview and print. |
| Thermal receipts | Rendered in the app → bitmap → **ESC/POS raster**, sent RAW | Arabic prints correctly on any ESC/POS printer; silent printing. |
| Windows service | **WinSW** around a bundled `node.exe` + esbuild bundle | Auto-start, auto-restart, log rotation. |
| Logging | **pino** with redaction | Secrets can never reach the logs. |
| Desktop shell | **Tauri 2** (Rust) | Small, harder to tamper with; signed auto-updates from the LAN server. |
| UI | **React 19** + TS + **Vite**; TanStack Query/Router; Zustand (POS cart only) | |
| UI primitives | **React Aria Components** (headless) | Best RTL, keyboard and accessibility support; the custom design is applied later. |
| Styling | **CSS Modules** + **design tokens** (CSS variables), logical properties only | Stylelint blocks raw colors and sizes (golden rule 12). |
| i18n | **i18next** (ICU) | Lint blocks literal UI text; CI checks that `ar` and `en` have the same keys. |
| Tests | **Vitest**, **fast-check**, **Playwright** | See the test plan in `phase-1-plan.md`. |

---

## 2. Topology and runtime components

```
┌──────────────────────────── MAIN SERVER PC (BitLocker, UPS) ────────────────────────────┐
│  PostgreSQL 18 ── listens on 127.0.0.1 only                                              │
│        ▲ role artepool_api                ▲ role artepool_backup                         │
│  ┌─────┴──────────────────────┐   ┌───────┴──────────────────────────────────┐           │
│  │ artepool-api (service)     │   │ artepool-backup (separate service)        │           │
│  │ • REST API /api/v1         │   │ • WAL archive (point-in-time recovery)    │           │
│  │ • PDF renderer (A4)        │   │ • hourly dump → 2nd PC / external drive   │           │
│  │ • scheduler: alerts,       │   │ • nightly base backup                     │           │
│  │   periods, integrity       │   │ • daily encrypted off-site upload         │           │
│  │   checks, audit anchors    │   │ • restore test + integrity checks         │           │
│  │ • client update feed       │   └───────────────────────────────────────────┘           │
│  └─────┬──────────────────────┘                                                           │
│        │ HTTPS :8443 (firewall: LAN subnet only)                                          │
└────────┼──────────────────────────────────────────────────────────────────────────────────┘
         │ TLS 1.3 · enrolled device secret · user session
   ┌─────┴───────────┬────────────────┬────────────────┬──────── … unlimited
 POS 1             POS 2            Office PC        Warehouse PC
 thermal + drawer  thermal + drawer A4 printer       label printer
 scanner           scanner
```

- **PostgreSQL listens only on `127.0.0.1`.** No other PC can reach the database. The P4 standby server will add one `pg_hba` line for that single PC.
- **Windows Firewall** allows inbound traffic only on port 8443, from the LAN subnet.
- **Clients hold no business data.** A client stores only its device secret (in Windows Credential Manager) and UI preferences.
- **Server unreachable:** the app shows a clear "Server unreachable" screen. A POS cart in progress stays in memory so it can be completed when the server is back, but nothing is ever saved halfway.
- **Idempotency keys:** every save request carries one. A retry after a network drop returns the original result and never creates a second sale.
- **Version lock-step:** the server states the minimum client version. Clients update themselves from the server over the LAN, and the update signature is verified ([0007](decisions/0007-no-code-signing-certificate-for-now.md)).

---

## 3. How the integrity rules are enforced

| Rule | Mechanism | Where |
|---|---|---|
| Money: integers, fixed precision ([0014](decisions/0014-money-precision-and-rounding.md)) | Amounts are `*_fils` (BIGINT, 2 dp). Unit prices, unit costs and average cost are `*_4dp` (BIGINT, AED × 10,000). Quantities are `numeric(14,3)`. One shared money module (BigInt internally, half away from zero) is the only path from 4 dp / quantities to fils. The database's stock costing uses the same rule, proven by shared test vectors. No cash rounding. | API + DB |
| No hard deletes | The API role has **no DELETE privilege**, except on draft lines and three link tables. A guard trigger on every table also rejects deletes. | DB |
| Posted documents immutable | Guard triggers allow only whitelisted columns to change after issue (settlement, print count, advance applied, oversell review). | DB |
| One transaction per operation | `withBusinessTx(ctx, fn)`: BEGIN → set request context → work → idempotency record → COMMIT. A deadlock is retried once (safe, because the operation is atomic). | API |
| Gapless numbering ([0011](decisions/0011-document-numbering-series.md)) | `sys.next_number(series)` inside the transaction, under a row lock. Tax documents are numbered at issue. A trigger allows the counter to move only by +1. POS invoices must use the POS series and A4 invoices the INV series (trigger). | DB |
| Every write audited, hash-chained | A row trigger on every business table (rejects writes without user context) plus explicit events. Sealed into the SHA-256 chain at **commit** (§5.4). | DB |
| Clients never touch PostgreSQL | Localhost-only listener; credentials only on the server (DPAPI). | Infra |
| Server time only | Database clock; business dates in Asia/Dubai. PC clock skew is logged and raises an alert. A server clock that goes backwards blocks writes. | API + DB |
| Stock derived from ledger | `inv.movements` is append-only. `inv.balances` is maintained only by a trigger that locks the row, costs the movement and **rejects negative stock**. A nightly recompute check runs. | DB |
| Double-entry | A deferred trigger at commit checks Σ debit = Σ credit and at least 2 lines. Unique keys make posting a document twice impossible. | DB |
| Monthly period lock ([0016](decisions/0016-monthly-period-lock.md)) | Postings, document issues, stock and cash postings into a closed or locked month are rejected. | DB |
| Invoice format by VAT registration ([0010](decisions/0010-invoice-format-by-vat-registration.md)) | `CHECK`: a full tax invoice ⇔ a buyer TRN is present. | DB |
| One cashier per drawer shift ([0004](decisions/0004-one-cashier-per-drawer-shift.md)) | Unique indexes allow one open shift per drawer and per cashier. A trigger only lets the shift's cashier sell on it. | DB |
| Least privilege | `artepool_api` cannot run DDL, DELETE (except as above), write the audit log, write stock balances, or change counters except through functions. | DB |

**Concurrency:**
- **Last unit sold on two terminals at once:** the second terminal waits on the balance-row lock, then takes the oversell-approval path ([0003](decisions/0003-pos-oversell-with-approval.md)) or stops.
- **Invoice numbers:** they stay consecutive under parallel issue.
- **Fixed lock order:**
  1. document numbers (all series an operation needs, in a fixed type order)
  2. stock balances (by item)
  3. documents being settled (by id)
  4. journal numbers
  5. the audit chain head, at commit

  PostgreSQL detects any remaining deadlock and the API retries once.
- **Timeouts and isolation:** `lock_timeout` and `statement_timeout` are set on every connection. The isolation level is `READ COMMITTED` with explicit locks.
- **Master-data edits** use optimistic locking (`row_version`).

---

## 4. Anatomy of a POS sale (one transaction)

```
App (POS section)                     API                                          Database
 │ POST /api/v1/pos/sales              │                                            │
 │ {idempotency key, cart id, lines,   │                                            │
 │  tenders, approval ids}             │                                            │
 ├────────────────────────────────────►│ 1. session, device, permission checks      │
 │                                     │ 2. user = cashier of the open shift on     │
 │                                     │    this drawer                             │
 │                                     │ 3. verify approvals (single-use, matching) │
 │                                     │ 4. BEGIN; set request context ────────────►│
 │                                     │ 5. idempotency key seen? → earlier result  │
 │                                     │ 6. re-price every line from the item price │
 │                                     │    (4-dp unit prices), discounts spread,   │
 │                                     │    VAT per line → fils via shared helper   │
 │                                     │ 7. format: full if customer VAT-registered,│
 │                                     │    else simplified                         │
 │                                     │ 8. numbers: POS-, ADJ- (if oversell), RCT- ►│ series row locks
 │                                     │ 9. invoice + lines (issued, hashed) ──────►│ CHECKs, immutability
 │                                     │10. stock short + oversell approval?        │
 │                                     │    → oversell adjustment (ADJ-) ──────────►│ balance += missing qty
 │                                     │11. stock movements sorted by item ────────►│ lock balance, cost at
 │                                     │                                            │ average, reject negative
 │                                     │12. payments per tender + allocations ─────►│ cash tied to the shift
 │                                     │13. journal entries (invoice, payments,     │
 │                                     │    oversell) ─────────────────────────────►│ balanced at commit
 │                                     │14. drawer event (if cash), e-invoice       │
 │                                     │    outbox row, idempotency result ────────►│
 │                                     │15. COMMIT ────────────────────────────────►│ audit rows sealed
 │◄────────────────────────────────────┤ number, totals, change due                 │
 │ silent thermal receipt + drawer kick│                                            │
```

- Any failure means a full rollback: nothing saved, no number used, stock untouched.
- Target end to end: under 2 s. Expected server time: 50–150 ms.
- **Cart removals before the sale** are sent separately as audit events. No approval is needed and they are always logged ([0005](decisions/0005-cart-removals-logged-without-approval.md)).

---

## 5. Key mechanisms

### 5.1 Money, VAT and discounts

- **Precision ([0014](decisions/0014-money-precision-and-rounding.md)):**

  | What | Unit | Column suffix |
  |---|---|---|
  | Amounts and totals | fils | `_fils` |
  | Unit price / cost / average | AED × 10,000 | `_4dp` |
  | Quantities | exact 3-dp decimal | — |
  | Rates | basis points (5% = 500) | `_bp` |

- **Line math, VAT exclusive:**
  1. `amount = round_fils(qty × unit_price_4dp)`
  2. `net = amount − line discount − share of document discount`
  3. `vat = round_fils(net × rate / 10000)`
  4. `total = net + vat`
- **Line math, VAT inclusive:** the same, except that the result after discounts is the gross; `vat = round_fils(gross × rate / (10000 + rate))` and `net = gross − vat`.
- **VAT per line ([0009](decisions/0009-vat-per-line.md)):** document VAT = Σ line VAT. VAT is shown per line and in the total.
- **Document discount** is spread across lines by value (largest-remainder method, exact to the fils) **before** VAT.
- **Lines store and print ([0012](decisions/0012-discounts-net-revenue-per-line.md)):** original price, amount before discount, discount, net, VAT and total. For items whose price includes VAT ([0032](decisions/0032-one-sale-price-with-vat-flag-and-customer-types.md)), that line's price and discount are labelled "incl. VAT", so every printed row adds up exactly.
- **Revenue is posted net of discount.** There is no discount account; discounts are reported from the lines.
- **Invoice format ([0010](decisions/0010-invoice-format-by-vat-registration.md)):** a VAT-registered customer gets a full tax invoice with TRN; everyone else gets a simplified tax invoice. This applies to POS and A4, and to notes.

### 5.2 Stock and moving-average cost

- **Balance rows:** each one (item × warehouse × status `available`/`defective`) holds the quantity, the **exact stock value at 4 decimals** (`value_4dp`), the derived `avg_unit_cost_4dp` and the **book value in fils**.
- **Outbound costing (inside the database):**
  - normally `value_4dp × qty / on-hand`, rounded to 4 dp
  - when the last unit leaves, the full remaining value leaves with it, so there is no rounding residue
- **Books always equal the rounded stock value:** each movement's amount in the ledger is the **change in the stock value rounded to the fils**. These amounts telescope, so the accounts always equal the stock value rounded to the fils, with no drift, while the average cost keeps all 4 decimals.
- **Inbound values** are supplied by the API. Returns come back at the cost they left at.
- **The database rejects negative stock.**
- **Oversell ([0003](decisions/0003-pos-oversell-with-approval.md)):**
  1. A supervisor approves.
  2. In the same transaction, an `oversell` adjustment adds the missing quantity at the current average, or else the last average, or else the item's fallback cost. If no cost is known, the sale is blocked.
  3. The adjustment is marked **pending review**, and the storekeeper is alerted.
- **Defective returns ([0015](decisions/0015-defective-returns-held-at-cost.md))** go to the `defective` bucket at cost, mapped to "Inventory – defective", until written off.
- **Bundles** deduct their components.
- **`warehouse_id`** is on everything from day one.

### 5.3 Advance and progress payments ([0013](decisions/0013-advance-and-progress-payments-vat.md))

**Operation "Receive payment"** (Invoices (A4) section), all in one transaction:
1. Allocate the payment to any issued tax invoices the user selects. These settlements carry no new VAT.
2. Any part **not** settling an issued tax invoice becomes an **advance/progress payment**. The system issues a tax invoice for the payment received:
   - doc type `advance_invoice`
   - number from the `INV-` series
   - VAT-inclusive at the agreed rate: `vat = round_fils(amount × rate / (10000 + rate))`
3. The receipt (`RCT-`) is allocated to that new document. Journals post: Customer advances (net) and VAT payable (VAT).

**Final invoice:**
- **Deduction lines.** Lines of kind `advance_deduction` each reference an earlier payment invoice, with negative net and VAT, so the invoice VAT = Σ item VAT − Σ deducted VAT.
- **Database checks:**
  - same customer
  - the payment invoice is issued
  - deductions never exceed what remains on each payment invoice
- **Posting.** The customer advances are released and the full revenue is recognised by line of business. Only the remaining VAT is added.

**Cancelled work:** a credit note against the payment invoice plus a refund.

### 5.4 Audit log and hash chain

- **Capture:** a row trigger runs on every business table. It stores who, which device, the server time, the changed columns (old and new) and the reason or approval. Secrets are redacted. **It rejects writes that carry no request context.**
- **Explicit events** use the same log:
  - login, failure, lockout, PIN switch
  - no-sale
  - **cart removals** (`event:pos.cart_line_removed`, `cart_qty_reduced`, `cart_cleared`)
  - prints and reprints (thermal or A4)
  - exports
  - X report
  - chain verification
- **Sealing at commit:**
  1. A deferred trigger locks the single chain-head row.
  2. It numbers the transaction's audit rows consecutively.
  3. It computes `SHA-256(prev_hash ‖ canonical row)` for each.
  4. It moves the head forward.

  The lock is taken last and held for microseconds, so sealing causes no deadlocks and no slowdown.
- **Protection:** the API cannot update, delete or truncate the log. Triggers block this even for the table owner.
- **Anchoring:** the chain head is printed on every **Z report**, written into each **off-site backup manifest** and recorded in `audit.anchors`. A rewritten chain would no longer match.
- **Verification:** a screen, a command-line tool and a nightly job report the first broken entry.

### 5.5 Approvals ("supervisor PIN + reason")

- **What an approval is:** a **single-use loan** of a supervisor's permission. It expires after 5 minutes, is bound to the action and amounts, and the approver must be a different user (`CHECK`).
- **Approvable actions:**
  - discount above the limit
  - price override
  - credit note or refund
  - payment reversal
  - **oversell**
  - stock adjustment above the threshold
  - **shift-close recount**
  - cash variance above the threshold
  - credit sale above the customer's limit
- **"No Sale"** needs its own permission plus a reason and is always logged.
- **Cart removals need no approval** ([0005](decisions/0005-cart-removals-logged-without-approval.md)).

### 5.6 Cash drawers and shifts ([0004](decisions/0004-one-cashier-per-drawer-shift.md), [0006](decisions/0006-one-recount-with-supervisor-approval.md))

- **One cashier per drawer shift.** A drawer has at most one open shift, and a cashier has at most one open shift. Only that cashier sells on it, and the over/short is theirs.
- **Closing:**
  1. **Blind count** by denomination.
  2. The variance is shown.
  3. **One recount** is allowed, with supervisor approval, in the supervisor's presence. The database permits at most one, and both counts are kept and printed.
  4. A variance above the threshold needs a separate acceptance approval.
- **Z report contents:** frozen totals (per tender, VAT by category, discounts, refunds, no-sales, paid-in/out, drops), both counts, and the audit chain anchor.

### 5.7 Numbering ([0011](decisions/0011-document-numbering-series.md))

- **Invoices:** `POS-` for POS invoices; `INV-` for A4 invoices and payment invoices.
- **Other series:** `CN-`, `DN-`, `Q-`, `RCT-`, `RFD-`, `RVS-`, `CV-`, `Z-`, `ADJ-`, `CNT-`, `JV-`.
- **Format:** prefix + 6 digits, continuous. A start number can be set to continue an old system's numbering.

### 5.8 Accounting ([0018](decisions/0018-chart-of-accounts-and-posting-map.md), pending accountant review)

- **Automatic double-entry postings start in P1,** following the [posting map](accounting/posting-map.md).
- **Revenue and cost of sales are split by line of business:** supplies, construction, maintenance, cleaning.
  - Every document has a line of business: POS defaults to supplies.
  - Each line inherits it, unless the item has its own default (for example a cleaning service sold at the counter).
  - Journal lines also carry it as a reporting dimension.
- **All accounts and mappings are configurable data.** Go-live waits for the accountant's approval of the chart and the posting map.

### 5.9 E-invoicing ([0019](decisions/0019-einvoicing-via-accredited-provider.md))

- **The ERP is the system of record.** An accredited service provider will transmit documents through its API.
- **P1:** every issued tax document has a UUID, a canonical content hash and an `ops.outbox` row:
  - `not_required` before `einvoice.mandatory_from`
  - `pending` after it
- **The sender** is built when the go-live date and the provider are known. This may be earlier than P4.

---

## 6. Security design

- **Device enrollment ([0024](decisions/0024-device-enrollment-proves-the-server.md)):**
  1. The owner creates a one-time code in Settings → Devices (10 minutes, single use; a new code cancels the previous one). The first PC uses `pnpm device:code` on the server PC ([0025](decisions/0025-first-owner-and-pc-from-server-commands.md)).
  2. The server address and the code are typed on the new PC. The code never crosses the network: both sides prove they know it (HMAC over the server's CA certificate and fresh nonces, keyed by an Argon2id-derived key), so the PC knows it is talking to the genuine server before it trusts the CA.
  3. The PC receives a random 256-bit device key, kept in Windows Credential Manager (the server stores only its SHA-256). The key is valid for a year and renews itself automatically.

  Unknown PCs cannot reach the login screen. Revoking a device takes one click plus a reason and cannot be undone ([0026](decisions/0026-users-and-devices-never-deleted.md)).
- **Users:**
  - Argon2id passwords, PINs and recovery codes. Passwords: 10+ characters, common ones refused, no forced expiry ([0023](decisions/0023-password-rules.md)).
  - Lockout after N failures (15 minutes), with a separate PIN failure counter (blocked until the owner unblocks it) and per-device rate limits.
  - Each user has one sign-in method: **PIN** (4 digits, **POS PCs only**), **password**, or **password + TOTP** (mandatory for roles flagged `requires_2fa`) ([0021](decisions/0021-cashier-pin-sign-in-on-pos-pcs.md)). Office PCs always need a password. A password user's PIN is used only for approvals.
  - TOTP replay is blocked. 10 one-time recovery codes; an emergency 2-step reset works only on the server PC ([0022](decisions/0022-owner-2-step-recovery.md)).
  - **Trusted PCs** ([0027](decisions/0027-trust-this-pc-for-the-2-step-code.md)): after the 6-digit code, that PC is remembered (box ticked by default) for `security.trusted_device_days` (3650, in practice until the password changes, [0077](decisions/0077-two-step-code-once-per-pc.md)). There, the password alone gives a full session (sign-in method `trusted_device`). The database enforces it: only the person, on that PC, never on a POS PC. The trust ends by itself on a new password, a 2-step change, deactivation, revoke or the PC becoming POS. The owner can end it in Settings → Devices.
  - **Last resort** ([0029](decisions/0029-owner-password-reset-on-the-server-pc.md)): `pnpm owner:reset-password` on the server PC. A reason is required. It gives a temporary password shown once, unlocks, ends all owner sessions and trusted PCs, and optionally clears the 2-step setup. It is audited, and the owner sees a notice with the time and reason when choosing their own password.
  - **Forgot password** ([0028](decisions/0028-forgot-password-with-phone-and-recovery-code.md)): username + phone code + one recovery code + a new password, from the sign-in screen. Both codes are claimed in one transaction. It works while locked and unlocks the account. It ends every session and trusted PC of that person, then signs them in. The same answer is given for any wrong part.
  - The first owner is created with `pnpm owner:create` on the server PC. There is exactly one active owner; it cannot be deactivated.
  - Users are deactivated with a reason, never deleted ([0026](decisions/0026-users-and-devices-never-deleted.md)).
- **Sessions:**
  - Random 256-bit tokens; only their SHA-256 is stored.
  - Server-side idle lock and absolute expiry; instant revoke.
  - A password change, user deactivation or device revoke ends the affected sessions. Sessions are ended with a reason, never deleted.
  - A password + TOTP sign-in first gets a short "second factor" session; after the code it is replaced by a new full session with a new token.
- **Permissions:**
  - Granular `module.action` codes, checked by the server on every route.
  - The UI only hides buttons.
  - Default roles: Owner, Accountant, Cashier, Storekeeper, Technician. Custom roles are allowed.
  - Owner-only permissions (users, roles, devices, settings, numbering series and, from [0030](decisions/0030-company-details-owner-only.md), company details) can never be given to another role; the database refuses it.
- **Secrets:**
  - TOTP and future integration secrets use AES-256-GCM, with the master key protected by Windows DPAPI. The key is never in the database or its backups; the owner keeps an offline copy.
  - Only card last 4 digits and auth codes are stored.
- **TLS:**
  - A local CA with **name constraints**, so it can only vouch for the ARTÉPOOL server.
  - TLS 1.3 only, never disabled.
- **The PC's secure side (M1):**
  - The screens never hold the device key and never open a network connection. They ask a small "bridge" to enroll the PC or to send an API request; the contract is `packages/shared/src/contracts/bridge.ts`.
  - In the Windows app the bridge is Rust (`apps/desktop/src-tauri/bridge`): TLS 1.3 only (rustls), trusting only the pinned ARTÉPOOL CA, with the server name and the CA's name constraints checked; the device key lives in Windows Credential Manager. It checks every request from the screens again (API paths only, no DELETE).
  - In development in a browser, the Vite dev server plays the same part (`tools/dev-bridge`), with the device key in `.secrets/`.
  - The session token is kept in memory only; closing the app ends the sign-in.
  - The app window has a strict Content-Security-Policy (no outside content, no direct connections) and JavaScript built-ins are frozen.
- **Releases ([0007](decisions/0007-no-code-signing-certificate-for-now.md)):**
  - Tauri update signatures are mandatory.
  - Installers are unsigned for now, with SHA-256 checksums published and installation documented in the runbook.
- **Exports** require a permission and are always logged.

---

## 7. Printing and hardware ([0008](decisions/0008-printing-pos-silent-a4-section.md))

| What | How |
|---|---|
| **POS thermal receipt** (80 mm) | Prints **automatically and silently** after each sale or refund. HTML layout → 576-px bitmap → ESC/POS raster, sent RAW to the Windows queue by the Rust layer, then a cut. Full or simplified tax invoice content, Arabic/English/both. |
| **Cash drawer** | ESC/POS pulse through the printer, only for cash tenders, cash movements, counts and a permitted No Sale. Each opening is logged. If the printer reports status, "left open" alerts are raised. |
| **Invoices (A4) section** | A separate area of the app. The server renders a PDF from bilingual templates, and the app opens the **Windows print dialog**. Covers A4 invoices, payment invoices, credit notes, quotations and statements. |
| **A4 reprint of a POS sale** | Opened from the A4 section and printed in A4: same document, same `POS-` number. `print_count` is incremented and the reprint is logged. Prints after the first are marked "Copy / نسخة" (setting). |
| **Barcode scanner** | Keyboard wedge: a fast burst of keys + Enter is treated as a scan. Pack barcodes carry their own quantity. |
| **Label printer** | Raw ZPL/TSPL or raster, decided once the model is known. |

- **Fonts:** a free Arabic + Latin font is bundled until the custom design arrives.
- **WebView2:** the offline WebView2 installer is bundled.
- **Hardware isolation:** all hardware code is behind one interface in `apps/desktop/src-tauri`.

---

## 8. Backup and disaster recovery

| What | How | When | Where |
|---|---|---|---|
| Continuous changes | WAL archiving, compressed; `archive_timeout` 5 min | Continuous | Second disk **and** second PC / NAS |
| Physical base backup | `pg_basebackup` | Nightly | Second PC / external drive; keep 7 |
| Logical backup | `pg_dump -Fc` | Hourly | Keep 48 hourly + 30 daily |
| Off-site | Dump encrypted with `age`, then uploaded to Google Drive / OneDrive. The server holds only the public key; the private key stays offline with the owner. | Daily when online | 30 daily + 12 monthly |
| Offline copy | External drive filled, then unplugged | Weekly | Office safe |
| Restore test | Restore into `artepool_restore_test`, then run all integrity checks | Monthly reminder + before every upgrade | Server |
| Health | `ops.backup_runs` / `ops.integrity_runs` → "System health" screen + alerts | Continuous | — |

**Upgrades:** backup → rehearse the migrations on a restored copy → stop the API → migrate → start → clients update themselves.
