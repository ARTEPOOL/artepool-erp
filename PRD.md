# ARTÉPOOL ERP — Product Requirements Document (PRD)

**Version:** 1.16
**Date:** 2026-10-07
**Owner:** Mohammed Yasser Al Huraidi (partner, ARTÉPOOL)
**Status:** Scope approved. Owner and accountant decisions applied (see `docs/decisions/`). **Phase 1 plan approved (2026-10-07).**

---

## 1. Overview

An **offline-first desktop system** for ARTÉPOOL to run invoicing, point of sale, inventory, cash management, services and accounting from computers on the company's premises. Daily work never depends on the internet.

The system is **built for ARTÉPOOL's internal use**, not as a commercial product for now. There is no licensing, activation or per-device limit.

### 1.1 Business context

ARTÉPOOL is a swimming pool company headquartered in **Al Ain, Abu Dhabi, UAE**. The system must serve all four of its lines of business:

| Line of business | What the system must support |
|---|---|
| Pool supplies retail (showroom) | POS, barcode sales, stock, cash drawer, promotions |
| Pool construction | Quotations, advance and progress payments, project cost vs. budget, project profitability |
| Pool maintenance | Service jobs, technicians, parts and labour, site visits |
| Pool cleaning | Recurring contracts, visit schedules, automatic recurring invoices |

Revenue is reported separately for each line of business ([decision 0018](docs/decisions/0018-chart-of-accounts-and-posting-map.md)).

### 1.2 Top priorities (in order)

1. **Database integrity:** data must never be lost, corrupted or silently changed.
2. **Security:** only authorised people can perform sensitive actions, and every action is traceable.
3. Correct UAE VAT handling and tax-ready reports.
4. Speed and simplicity at the counter.

---

## 2. Scope decisions (confirmed by the owner)

| Decision | Value | Design implication |
|---|---|---|
| Number of devices | **Open / unlimited** | Client–server architecture; no hard-coded limit on terminals or users |
| Warehouses | **One warehouse now, must support more later** | Every stock movement carries a `warehouse_id` from day one. The UI hides warehouse selection while only one warehouse exists. |
| Languages | **Arabic and English** | Full i18n from day one, RTL and LTR layouts, bilingual printed documents |
| UI design | **Fully custom**; reference designs provided at implementation time | Build on a theming layer (design tokens) so the visual design can be applied later without rewriting screens |
| Connectivity | **Offline-first** | All daily operations work without internet. Internet is used only for optional cloud backup, WhatsApp sending and e-invoicing transmission. |
| Platform | Windows 10/11 desktops | Desktop app, not a website |
| Repository | **Private GitHub repository `artepool-erp`**, separate from every other project | [0002](docs/decisions/0002-separate-private-repository.md) |
| Out-of-stock at POS | **Sale allowed with supervisor approval**; an "oversell" stock adjustment is posted for the storekeeper to review | [0003](docs/decisions/0003-pos-oversell-with-approval.md) |
| Cash shifts | **One cashier per drawer shift**; the cashier is responsible for that shift's over/short | [0004](docs/decisions/0004-one-cashier-per-drawer-shift.md) |
| Removing items from a POS cart | **Always allowed** before the invoice is issued; no approval needed; logged silently in the audit trail | [0005](docs/decisions/0005-cart-removals-logged-without-approval.md) |
| Shift-close recount | **Allowed once**, with supervisor approval | [0006](docs/decisions/0006-one-recount-with-supervisor-approval.md) |
| Code-signing certificate | **Not now**; rely on signed updates; revisit later | [0007](docs/decisions/0007-no-code-signing-certificate-for-now.md) |
| Printing | POS prints thermal receipts **silently**. A separate **"Invoices (A4)"** section prints through the print dialog. A POS sale can be reprinted in A4 (same document, same number). | [0008](docs/decisions/0008-printing-pos-silent-a4-section.md) |

---

## 3. Architecture

### 3.1 Tech stack (confirmed, [decision 0001](docs/decisions/0001-tech-stack.md))

| Layer | Choice | Reason |
|---|---|---|
| Database | **PostgreSQL 18** (≥ 16 compatible) on the Main Server PC, listening on localhost only | Robust multi-user concurrency, ACID transactions, roles, WAL and point-in-time recovery, free |
| Backend | **Local API service**: Node.js 24 LTS + TypeScript, Fastify 5, Kysely on node-postgres, Zod contracts, running as a Windows service on the Main Server | One place for business rules and security; clients never touch the database directly |
| Clients | **Tauri 2 desktop app** with React 19 + TypeScript (Vite, TanStack Query/Router, React Aria Components, CSS Modules + design tokens, i18next) | Small, fast, harder to tamper with than Electron; full RTL support |
| Client ↔ server | HTTPS (TLS 1.3) over the local network, private ARTÉPOOL certificate authority, enrolled devices | Encrypted and authenticated, even on the LAN |
| Migrations | Numbered plain-SQL migrations with checksums | Safe upgrades without data loss |
| Tests | Vitest (unit + integration against real PostgreSQL), fast-check, Playwright | Money, VAT, stock and numbering are proven by tests |

Full detail: [`docs/architecture.md`](docs/architecture.md).

### 3.2 Topology

```
                ┌──────────────────────────────┐
                │        MAIN SERVER PC         │
                │  PostgreSQL + API service     │
                │  Backup jobs + audit chain    │
                └──────────────┬───────────────┘
                               │  LAN (TLS)
     ┌──────────────┬──────────┴───┬──────────────┐
  Showroom POS   Showroom POS    Office PC     Warehouse PC   … (unlimited)
```

- **ARTÉPOOL now ([0085](docs/decisions/0085-server-on-the-pos-pc.md)):** the POS PC is also the Main Server (PostgreSQL + API as Windows services); the owner's laptop is the only Office PC and works on the shop LAN only; no remote access in Phase 1 ([0093](docs/decisions/0093-no-remote-access-in-phase-1.md); the VPN plan of [0084](docs/decisions/0084-remote-access-through-private-vpn.md) is deferred). One cashier now; two cashiers on the same POS PC or a second POS PC later without redesign ([0087](docs/decisions/0087-cashiers-and-drawers-growth.md)).
- **One app for every PC:** the kind a PC is enrolled as decides the mode. POS PCs start in an app-level kiosk mode that only the owner can unlock, for a limited time ([0082](docs/decisions/0082-app-mode-by-device-kind-and-pos-kiosk.md), [0083](docs/decisions/0083-exiting-kiosk-mode-owner-only.md)).
- The Main Server PC can also be used as a normal workstation.
- Clients find the server through a configured address, with optional auto-discovery on the LAN.
- If a client loses the connection, it shows a clear "server unreachable" state and never saves partial data.

### 3.3 Future-proofing

- **Standby server:** a second PC can hold a near-real-time replica and be promoted if the main one fails.
- **Multi-warehouse / branch:** the schema is ready now; the UI comes later.
- **E-invoicing (UAE):** see section 10.4. Invoices are stored in a structured, transmittable form, and an outbox queues them for later sync.
- **Mobile dashboard (Phase 2):** no cloud database in Phase 1; summary figures go through an outbox to a read-only mobile dashboard later, nothing flows back ([0088](docs/decisions/0088-no-cloud-database-outbox-for-mobile.md)).

---

## 4. Non-negotiable database rules

These rules apply to every table and every feature.

| # | Rule | Detail |
|---|---|---|
| 1 | **No hard deletes of business records** | Never `DELETE` invoices, payments, stock movements, journal entries, customers or items. Cancel with reversal documents (credit notes, reversing entries) or deactivate (`is_active = false`). |
| 2 | **Money as integers, fixed precision** | Document amounts and totals are stored in **fils** (`BIGINT`, 2 decimals): 100.50 AED = 10050. **Unit prices, unit costs and weighted-average cost** are stored with **4-decimal precision** as integers (`BIGINT`, AED × 10,000): 1.2345 AED = 12345. Values are rounded to the fils **only** through the shared, tested rounding helper. No floating point anywhere in money math. **No cash rounding:** totals are exact to the fils. ([0014](docs/decisions/0014-money-precision-and-rounding.md)) |
| 3 | **Atomic transactions** | A sale, its stock deduction, its payment and its journal entry commit together or not at all. |
| 4 | **Double-entry ledger** | Every financial event posts balanced debit/credit lines to the general ledger, **starting in Phase 1**. A database check ensures each journal entry balances. |
| 5 | **Gapless sequential numbering** | Per document series (POS invoice, A4 invoice, credit note, quotation, receipt…), allocated inside the transaction. No gaps, no reuse. ([0011](docs/decisions/0011-document-numbering-series.md)) |
| 6 | **Immutable posted documents** | An issued or posted invoice can never be edited. Corrections are made only through credit or debit notes. |
| 7 | **Tamper-evident audit log** | Every create, update and status change records the user, device, timestamp (server time), entity, old value, new value and reason. Each row stores a hash of its content plus the previous row's hash (hash chain). A verification tool reports any break in the chain. |
| 8 | **Constraints in the database** | Foreign keys, NOT NULL and CHECK constraints (quantities, statuses, totals). The database rejects bad data even if the app has a bug. |
| 9 | **Period locking** | Accounting periods are **monthly**. A locked month cannot receive new postings or changes. Records are never deleted. ([0016](docs/decisions/0016-monthly-period-lock.md)) |
| 10 | **Server time only** | All timestamps come from the server, stored in UTC and displayed in Asia/Dubai time. Client clock tampering is detected and logged. |
| 11 | **Versioned migrations** | Every schema change is a numbered migration, tested on a copy of real data before release. |
| 12 | **Least-privilege DB roles** | The API connects with a role that cannot drop tables or alter the audit log. Owner/admin database credentials are not stored on client PCs. |

---

## 5. Security requirements

| Area | Requirement |
|---|---|
| Disk | BitLocker on the Main Server and on any PC holding backups |
| Database | Sensitive columns encrypted. The database listens on localhost only, and the firewall allows only the API port from the LAN. |
| Transport | TLS between clients and the API |
| Passwords | Argon2id hashes; never stored or logged in plain text |
| Passwords (rules) | At least 10 characters, common passwords refused, no forced symbols, no forced expiry. A password change ends the user's other sessions ([0023](docs/decisions/0023-password-rules.md)). |
| Login | Lockout after repeated failures. Idle lock per kind of PC, off by default ([0079](docs/decisions/0079-screen-lock-optional.md)); on POS PCs the cashier's session stays open, with a "Lock screen" button and an owner-only auto-lock, off by default ([0090](docs/decisions/0090-pos-idle-behaviour.md)). Cashiers sign in with a 4-digit PIN **only on PCs enrolled as POS**; weak PINs refused; 5 wrong PINs block the PIN until the owner unblocks it. Office PCs always need a password. A user's PIN is also used for supervisor approvals ([0021](docs/decisions/0021-cashier-pin-sign-in-on-pos-pcs.md)). |
| Owner 2FA | TOTP (authenticator app) for owner/admin accounts; works offline. 10 one-time recovery codes, plus an audited emergency reset that works only on the server PC ([0022](docs/decisions/0022-owner-2-step-recovery.md)). The phone code is asked once per PC: the PC is then remembered until the password changes; on POS PCs only for the owner ([0078](docs/decisions/0078-owner-remembered-on-pos-pcs.md)); the owner can end it at any time ([0027](docs/decisions/0027-trust-this-pc-for-the-2-step-code.md), [0077](docs/decisions/0077-two-step-code-once-per-pc.md)). A forgotten password is recovered in the app with the phone code and one recovery code ([0028](docs/decisions/0028-forgot-password-with-phone-and-recovery-code.md)). If the phone or the recovery codes are lost too, an audited emergency password reset works only on the server PC ([0029](docs/decisions/0029-owner-password-reset-on-the-server-pc.md)). |
| Devices | Only enrolled PCs can reach the server. Enrollment uses a 10-minute one-time code that also proves the server is genuine ([0024](docs/decisions/0024-device-enrollment-proves-the-server.md)). The first owner and first PC are created by commands on the server PC ([0025](docs/decisions/0025-first-owner-and-pc-from-server-commands.md)). Users are deactivated and PCs revoked, always with a reason, never deleted ([0026](docs/decisions/0026-users-and-devices-never-deleted.md)). |
| Roles & permissions | Granular permissions per action, not just per screen. Default roles: Owner, Accountant, Cashier, Technician, Storekeeper. Custom roles allowed. Company details (printed on every tax invoice) are edited by the owner only ([0030](docs/decisions/0030-company-details-owner-only.md)). |
| Supervisor approval | Required (the supervisor's one-time 2-step code + mandatory reason, [0074](docs/decisions/0074-approvals-with-the-phone-code.md)) for: discounts above the user's limit, refunds and credit notes, price override, selling beyond available stock (oversell), stock adjustments above a threshold, shift-close recount, cash variance above a threshold. **"No Sale" drawer open** requires its own permission plus a reason and is always logged. **Removing items from an unpaid POS cart needs no approval** but is always logged ([0005](docs/decisions/0005-cart-removals-logged-without-approval.md)). |
| Audit | Every sensitive action is logged (see rule 7) and viewable by the owner |
| App integrity | Signed updates (the app refuses unsigned or tampered updates) and no secrets in client code. **No installer code-signing certificate for now**; revisit later ([0007](docs/decisions/0007-no-code-signing-certificate-for-now.md)). |
| Ransomware resilience | At least one backup copy that is not continuously connected to the network |
| POS kiosk | POS PCs run the app full screen in kiosk mode: closing refused, restarted by a watchdog; the cashier's Windows account is a standard user that cannot stop the services or read the database or keys; every exit attempt and unlock is audited and alerts the owner; a per-PC "Kiosk lock" switch kept on the server (default on; owner only with 2-step and a reason; off for 15 min / 1 hour / until turned back on, or 15 minutes with the owner's code on the lock screen, and off by itself while the owner is signed in on that PC until sign-out or screen lock ([0091](docs/decisions/0091-kiosk-lock-off-while-the-owner-is-signed-in.md)); a "القفل متوقف / Kiosk lock is off" banner and an alert while off; PIN, shifts and permissions unchanged, [0089](docs/decisions/0089-kiosk-lock-switch-per-pos-device.md)); only the owner unlocks ([0082](docs/decisions/0082-app-mode-by-device-kind-and-pos-kiosk.md), [0083](docs/decisions/0083-exiting-kiosk-mode-owner-only.md), [0085](docs/decisions/0085-server-on-the-pos-pc.md)) |
| Remote access | None in Phase 1: no VPN, never an internet-facing port, no router port forwarding, no remote-desktop tools; the laptop works on the shop LAN and can be revoked at once. The design stays VPN-agnostic so remote access ([0084](docs/decisions/0084-remote-access-through-private-vpn.md), deferred) can be added later; remote monitoring comes with the Phase 2 mobile dashboard ([0093](docs/decisions/0093-no-remote-access-in-phase-1.md)) |
| First-run setup | After the server install, a one-time wizard on the server PC: company details, the owner account, phone 2-step, recovery codes (confirmed), enroll this PC as the POS; locked afterwards in the database; console commands are emergency tools ([0092](docs/decisions/0092-first-run-setup-wizard.md)) |
| Cashier and laptop | The owner adds the cashier in Settings → Users (PIN); the PC kind decides the mode, no separate icon; the laptop is enrolled with a code from Settings → Devices and signs in with the same owner account ([0094](docs/decisions/0094-adding-the-cashier-and-the-owner-laptop.md)) |
| Data export | Exports (CSV/PDF/Excel) are permission-controlled and logged |

---

## 6. Backup and disaster recovery

| Requirement | Detail |
|---|---|
| 3-2-1 rule | 3 copies, 2 different media, 1 off-site |
| Local automatic backup | Hourly to a second PC or external drive |
| Off-site backup | Daily, **encrypted with `age` before upload**, to a **dedicated Google Drive account** (2-step on) when internet is available; the private key stays offline with the owner ([0086](docs/decisions/0086-backups-local-and-google-drive.md)) |
| External drive | Weekly reminder to plug in the backup drive for a copy that is then unplugged |
| Point-in-time recovery | WAL archiving, so data can be restored to a specific minute |
| Restore tool | Built-in restore to a test database, plus a monthly restore-test reminder |
| Backup health | A dashboard shows the last successful backup. An alert fires if a backup fails or is older than the threshold. |
| Hardware | UPS on the Main Server (documented requirement); the health screen reminds the owner until a UPS is confirmed ([0085](docs/decisions/0085-server-on-the-pos-pc.md)) |

---

## 7. Internationalisation (Arabic + English)

- **Every UI string** comes from translation files (`ar`, `en`). There is no hard-coded text in components.
- **Per-user language preference.** Switching language switches layout direction (RTL ↔ LTR) instantly.
- **Bilingual master data:** items, categories, services and units have `name_ar` and `name_en`. Customers and suppliers have an optional second-language name.
- **Printed documents:** tax invoices, credit notes and quotations print **bilingual** (Arabic + English) by default. Receipts and job cards are configurable (Arabic, English or both).
- Numbers use Western digits (0-9) by default, configurable. Dates are Gregorian, with a configurable format.
- Search works in both languages and tolerates Arabic letter variants (ا/أ/إ/آ, ة/ه, ى/ي).
- Fonts must render Arabic correctly on screen and on thermal printers.

---

## 8. UI and theming

- The final visual design is **custom**. The owner will supply reference designs at implementation time.
- Until then, screens are built on a **design-token layer** (colors, typography, spacing, radius) and reusable components, so the custom design can be applied centrally.
- Counter screens (POS) must be fully usable with the keyboard and a barcode scanner, and touch-friendly where possible.
- Every destructive or financial action shows a clear confirmation with the amount.
- The app has two separate selling areas ([0008](docs/decisions/0008-printing-pos-silent-a4-section.md)):
  - **POS** (counter sales): thermal receipts print automatically.
  - **Invoices (A4)** (office invoicing, advance payments, credit notes, A4 reprints): prints through the print dialog.

---

## 9. Modules

Phase tags: **[P1]** to **[P4]** (see section 13).

### 9.1 Users, roles and audit [P1]
- Users, roles, granular permissions, supervisor limits (max discount %, max discount amount).
- Audit log viewer with filters (user, date, entity, action) and hash-chain verification.

### 9.2 Master data [P1]
- Company profile: bilingual name, TRN, address, logo, contact details.
- Items: code (suggested by the app, fixed after creation), barcode(s), bilingual name, category, unit, **purchase price** (without VAT, owner only, 4-decimal precision; the weighted-average cost takes over once purchases exist; [0038](docs/decisions/0038-item-purchase-price-owner-only.md)), VAT category (rate configurable per item), reorder level, default line of business, active flag.
- **One sale price per item** (4-decimal precision) with a **"Price includes VAT"** switch, set on the item screen. The tables are ready for a second price level by customer type later; no screen for it in P1 ([0032](docs/decisions/0032-one-sale-price-with-vat-flag-and-customer-types.md)).
- Item types: stock item, service/labour, **bundle** (kit made of components).
- **Customers:**
  - **Type** (required): Individual / Contractor / Company.
  - VAT registration status and TRN (15 digits starting with 100, unique).
  - Phone (required, unique).
  - **Cash or credit:** new customers start as cash with a zero credit limit. Giving credit (limit + payment terms) needs the `customers.credit` permission and a reason, and is audited ([0036](docs/decisions/0036-customers-start-as-cash.md), [0037](docs/decisions/0037-master-data-defaults.md)).
- Suppliers, technicians (no login needed), payment methods, warehouses.
- Lines of business: pool supplies, construction, maintenance, cleaning. Each has its own revenue account.
- Bulk import from Excel templates: **all or nothing**, after a check that reports every problem by row and column ([0031](docs/decisions/0031-excel-import-all-or-nothing.md)).
- **Never deleted:** master data is deactivated with a reason and can be reactivated.
- **Screen placement** ([0034](docs/decisions/0034-master-data-screen-placement.md)):
  - side menu: Items & stock, Customers, Suppliers, Accounting
  - Settings: Company, VAT & numbering, Lists

### 9.3 Inventory [P1]
- Stock movements ledger: every in/out is a row. Stock on hand is derived from it and never edited directly.
- **Moving weighted-average cost**, recalculated on every inbound movement, kept with 4-decimal precision.
- Stock count and adjustments with mandatory reason codes; threshold alerts.
- Low-stock alerts per item.
- **Out-of-stock at POS:** the sale is allowed with supervisor approval. The system posts an **oversell adjustment** in the same transaction and flags it for the storekeeper to review ([0003](docs/decisions/0003-pos-oversell-with-approval.md)).
- **Defective stock bucket** for returned broken goods, separate from sellable stock. Defective goods are **held at cost in "Inventory – defective" until written off** ([0015](docs/decisions/0015-defective-returns-held-at-cost.md)).
- Bundles deduct their components.
- Barcode label printing: sizes 25×15 to 100×50 mm, A4 label sheets and custom sizes, through the print dialog for now ([0043](docs/decisions/0043-barcode-label-sizes.md)).
- **Who sees stock cost and value:** owner and accountant only; storekeeper and cashier see quantities ([0040](docs/decisions/0040-stock-cost-visibility.md)). Adjustments above 500.00 AED need a supervisor's approval ([0041](docs/decisions/0041-stock-adjustment-approval-threshold.md)). Opening stock is posted once, by the owner ([0042](docs/decisions/0042-opening-stock-owner-only.md)). Full counts are blind ([0044](docs/decisions/0044-blind-stock-counts.md)).
- Multi-warehouse ready; transfers between warehouses come in [P3].

### 9.4 Sales documents [P1]
- **Quotation → invoice** in one click.
- Invoice lifecycle: Draft → Issued (unpaid) → Partially paid → Paid. A draft does not count in revenue or stock and has no number.
- **Invoice format follows the customer's VAT registration** ([0010](docs/decisions/0010-invoice-format-by-vat-registration.md)):
  - customer **not** VAT-registered → **simplified tax invoice**
  - customer VAT-registered → **full tax invoice** showing the customer's TRN
  - **A4 invoices (INV-)** are full tax invoices for a registered customer or a named customer with an address on file, simplified for the walk-in or a customer without an address; nothing is typed on the invoice ([0071](docs/decisions/0071-a4-invoices-full-and-reprints-current-design.md)). The rule above applies to POS sales, advance invoices and debit notes.
- **Numbering:** two separate gapless invoice series ([0011](docs/decisions/0011-document-numbering-series.md)):
  - **`POS-`** for POS sales
  - **`INV-`** for A4 invoices, including advance and progress payment tax invoices

  Credit notes, receipts, refunds and other documents have their own series.
- Partial payments. Multiple payment methods per invoice (cash, card, bank transfer, cheque, custom).
- **Advance and progress payments** ([0013](docs/decisions/0013-advance-and-progress-payments-vat.md)):
  - VAT is charged on every payment when it is received, if the payment is not settling an already-issued tax invoice. This applies whatever the stage: advance, during construction, after completion.
  - Each such payment produces its own **tax invoice for the payment received** (`INV-` series).
  - The **final invoice deducts the previous payments and their VAT**, so VAT is never counted twice.
  - Payments that settle an already-issued tax invoice do not create VAT again.
- **Credit notes** have their own number, reference the original invoice and reverse its VAT. The original invoice is never changed.
- **Discounts** ([0012](docs/decisions/0012-discounts-net-revenue-per-line.md)):
  - A negotiated discount on the total is allowed within staff limits; above the limit it needs supervisor approval.
  - A total discount is spread across the lines before VAT.
  - Every invoice line shows the original price, the discount amount and the net amount. The discount is stored per line, so reports show total discounts given.
  - Revenue is posted **net of discount**. There is no separate "sales discounts" account.
- Customer **statement of account** for any date range (PDF/print).
- **Sections ([0045](docs/decisions/0045-sales-sections-in-the-side-menu.md)):** Invoices (A4), Quotations and Receipts each have their own entry in the side menu.
- **Invoices (A4) section:** create, print (with print dialog) and reprint A4 documents. **Any POS sale can be reprinted in A4 format**: same document, same number, counted and logged as a reprint ([0008](docs/decisions/0008-printing-pos-silent-a4-section.md)).
- Send PDF by WhatsApp/email when online [P4].

### 9.5 Point of Sale [P1]
- Fast item search and barcode scan, categories, cart, quantity edits.
- Removing items or reducing quantities before the invoice is issued is **always allowed without approval** and **logged silently** in the audit trail.
- Split tender (cash + card + others). Card: amount and the terminal's approval code only; no card number, not even the last 4 digits ([0061](docs/decisions/0061-card-payments-no-card-data.md)).
- Discounts within the role's limit (cashier 5% by default); above it, and for any unit-price change, a supervisor approves ([0059](docs/decisions/0059-pos-discounts-and-prices.md)).
- Cash customer by default; a VAT-registered customer gets a full tax invoice with their TRN automatically ([0062](docs/decisions/0062-pos-receipt-and-customer.md)).
- **Returns:** a "Return" button with supervisor approval issues a credit note linked to the original invoice, reverses stock and refunds from the currently open shift (card sales as card) ([0060](docs/decisions/0060-pos-returns.md)).
- **Thermal receipt (80 mm) prints automatically** (silent printing) after each sale, in Arabic and English together, on standard ESC/POS printers ([0055](docs/decisions/0055-thermal-printer-esc-pos.md), [0062](docs/decisions/0062-pos-receipt-and-customer.md)). A4 copies are printed from the Invoices (A4) section.
- Each sale creates an invoice (`POS-` series) and deducts stock in the same transaction.
- Out-of-stock sale with supervisor approval (see 9.3).
- Hold/resume cart.

### 9.6 Cash drawer and shifts [P1]
- The drawer is connected through the receipt printer's kick port (RJ11/RJ12) and opened by an ESC/POS command.
- **Each cashier has their own drawer shift** and is responsible for its over/short. Only the shift's cashier can sell on that drawer while the shift is open ([0004](docs/decisions/0004-one-cashier-per-drawer-shift.md)).
- **Open shift** with an opening float.
- The drawer opens automatically only for sales with a cash component.
- **No Sale** open: special permission + reason, always logged.
- **Paid-in / paid-out** (petty cash, change float) with a reason.
- **Cash drop** alert when cash in the drawer exceeds a configurable amount (AED 3,000 by default, [0057](docs/decisions/0057-cash-drop-alert.md)).
- **X report** (mid-shift, no close).
- **Z report / shift close** with a **blind count**: the cashier enters the counted cash by denomination (notes 1000–5, coins 1–0.05, plus an "other amount"; exact to the fils, [0056](docs/decisions/0056-blind-count-denominations.md)) without seeing the expected amount; the system then shows over/short.
- **One recount** is allowed, only with supervisor approval. Both counts are kept and printed on the Z report ([0006](docs/decisions/0006-one-recount-with-supervisor-approval.md)).
- A shift that can no longer be closed on its own PC (re-enrolled, broken or gone) is **closed from another PC by the owner or the accountant**, with a reason and a count; the drawer moves with a re-enrolled PC, and a PC with an open shift cannot be revoked ([0069](docs/decisions/0069-stuck-shifts.md)).
- Over/short is **accepted by the owner or the accountant** and posts to Cash over/short. History per cashier, with an alert when a cashier has a difference above AED 20 three times in 30 days (both configurable, [0058](docs/decisions/0058-shift-variance-acceptance.md)).
- Drawer-left-open alert where the hardware supports status reporting.

### 9.6a Print designer [P1]
- Settings → **Print designer**: the owner customises the layout of printed documents with a live preview ([0020](docs/decisions/0020-print-template-designer.md); design: `design/screens/11-print-designer.html`).
- Phase 1 templates: A4 tax invoice, quotation, credit note, 80 mm thermal receipt. Z report and barcode labels follow with their milestones.
- Adjustable: logo (upload, position, size), main colour (A4), print language (Arabic + English / Arabic / English), text size, optional fields on or off, welcome line, terms, footer, A4 margins, thermal width (80 or 58 mm).
- **Legally required fields are locked** and always printed. The list per document type is in [0064](docs/decisions/0064-print-designer-and-locked-fields.md) (pending the accountant's review): among them the seller's name, **address** and TRN on every tax invoice, and the customer's name, **address** and TRN on a full tax invoice. A full tax invoice is refused at issue without the customer's address.
- Receipts and statements use the A4 invoice design. The thermal receipt's language is chosen here. No QR code until e-invoicing ([0067](docs/decisions/0067-qr-code-deferred.md)).
- **Bank accounts** (several, UAE IBAN checked) are kept in Company details; the template chooses which one prints ([0065](docs/decisions/0065-company-bank-accounts.md)). An optional **customer PO number** on A4 invoices and quotations prints when filled ([0066](docs/decisions/0066-customer-po-number.md)).
- Templates are **versioned**; each issued document keeps the version it was issued with, so reprints match the original. Saves are audited. Owner only.

### 9.7 Purchasing and suppliers [P2]
- Purchase orders → goods received → supplier invoice.
- Supplier balances, payments, supplier statement.
- Reorder suggestions from low-stock levels.

### 9.8 Expenses and petty cash [P2]
- Expense entry with category, VAT (input tax) and an attachment (scanned receipt). Simple "New expense" (type, amount, date, note) posted to the ledger; built once the journals exist ([0039](docs/decisions/0039-owner-reports-dashboard.md)).
- Petty cash custody per employee.

### 9.9 Accounting [P1 core, P2 screens]
- **[P1]** Chart of accounts (provisional, editable). Revenue is split by line of business: pool supplies, construction, maintenance, cleaning.
  - The chart stays provisional until ARTÉPOOL's accountant approves it, and go-live waits for that approval.
  - The fiscal year runs January–December ([0035](docs/decisions/0035-fiscal-year-and-provisional-chart.md)).
- **[P1]** Automatic journal postings from every P1 module, following the posting map. The chart of accounts and posting map are **pending accountant review** before go-live ([0018](docs/decisions/0018-chart-of-accounts-and-posting-map.md)).
- **[P1]** Monthly accounting periods and period lock.
- **[P2]** Manual journal entries with approval.
- **[P2]** Accounts receivable / payable with **aging** reports.
- **[P2]** Bank and cash accounts; basic bank reconciliation.
- **[P2]** Period-close screens.

### 9.10 Reports [P2]
- Profit & loss (including by line of business), sales by period/category/item/user, top items by revenue and margin, discounts given.
- **VAT return report** (output VAT, input VAT, net payable) in the layout the accountant needs.
- **Quarterly VAT export package** in **Excel + PDF** ([0017](docs/decisions/0017-quarterly-vat-export-and-annual-archive.md)):
  - sales invoices (including advance/progress payment invoices)
  - credit notes
  - purchases with input VAT
  - a VAT summary
- **Annual archive file** combining all four quarters, organised by date.
- Stock valuation, stock movement, low stock, defective returns, oversell reviews.
- Cash/shift reports by cashier and tender.
- Export to PDF and Excel/CSV (permission-controlled and logged).

### 9.11 Maintenance and cleaning contracts [P3]
- **Pool profile per customer site:** location, size, volume, pump, filter, heater/chiller, build date, warranty.
- **Recurring contracts:** frequency, price, start/end, visits included, auto-generated recurring invoices, renewal alerts.
- **Visit schedule** per technician; visit report (chemical readings, work done, chemicals used, optional photos).
- **Technician van stock:** each technician is a mobile stock location; consumption at visits deducts from it.

### 9.12 Service jobs [P3]
- Job card: customer, site/equipment, reported issue, technician, promised date.
- Stages: Received → Diagnosing → Awaiting approval → In progress → Ready → Delivered.
- Parts and labour estimate → invoice in one click; parts deduct at billing.
- Printed job card with a customer signature line.

### 9.13 Construction projects [P3]
- Project created from an accepted quotation, with a budget by cost category.
- **Progress billing** uses the P1 advance/progress payment mechanism: each payment received gets its own tax invoice, and the final invoice deducts all previous payments and their VAT. Retention, if used, is still an open question.
- Actual cost tracking (materials issued from stock, labour, subcontractors, expenses) vs. budget.
- Project profitability report.

### 9.14 Promotions and loyalty [P4]
- Percentage, fixed, buy-X-get-Y and category-wide promotions with validity dates.
- Optional loyalty points.

### 9.15 Owner dashboard [P2]
- **Reports dashboard, owner only** ([0039](docs/decisions/0039-owner-reports-dashboard.md)): total sales; VAT due; sales without VAT; profit (sales without VAT minus the cost of goods sold). A detailed net-profit report after expenses (rent, bills). Date range: today (default), week, month, year, or from–to.
- Today's sales, cash position, receivables due, low stock, pending oversell reviews, overdue visits/jobs, backup health.

---

## 10. UAE tax and compliance

### 10.1 VAT
- **Four fixed UAE VAT categories:**
  - standard 5%
  - zero-rated
  - exempt
  - out of scope

  Each item has one. Only the owner can change a rate, with a reason; the change applies to new documents only and is audited ([0033](docs/decisions/0033-four-fixed-uae-vat-categories.md)).
- **VAT applies to every customer:** individuals, contractors and companies, with no exceptions. The customer type never changes the VAT ([0032](docs/decisions/0032-one-sale-price-with-vat-flag-and-customer-types.md)).
- **Prices can be tax-inclusive or tax-exclusive, set per item.**
  - If the price includes VAT, the system works the net and the VAT back out of it.
  - Otherwise it adds the VAT.
- **Every tax invoice** (A4 or POS receipt), for every customer, shows net, VAT and total separately.
- **VAT is calculated per line.** Invoice VAT total = sum of line VAT. VAT is shown per line and in the total ([0009](docs/decisions/0009-vat-per-line.md)).
- Rounding: half away from zero to the fils, per line, through the shared helper. **No cash rounding.**
- **VAT on payments received:** see 9.4 and [0013](docs/decisions/0013-advance-and-progress-payments-vat.md).

### 10.2 Tax invoice content
- **Simplified tax invoice** for customers who are not VAT-registered. **Full tax invoice** with the customer's TRN for VAT-registered customers.
- Content: "Tax Invoice" / "Simplified Tax Invoice" title (bilingual); supplier name, address and TRN; customer name, address and TRN (when VAT-registered); sequential invoice number; issue date; date of supply if different.
- Each line shows: description, quantity, original unit price, discount amount, net (taxable) amount, VAT rate, VAT amount and line total (in AED).
- Totals show taxable amount, VAT and total payable.
- Final invoices list the deducted advance/progress payments and their VAT.

### 10.3 Record retention
- Policy: **never delete**. Old periods can be archived but stay queryable.
- The legally required retention period is to be confirmed with the accountant. It does not affect the design, because nothing is deleted.

### 10.4 E-invoicing ([0019](docs/decisions/0019-einvoicing-via-accredited-provider.md))
- The **ERP remains the system of record**. E-invoicing will be done by **integrating with an accredited service provider (ASP) via API**. The provider only transmits documents to the tax authority.
- Every issued tax document gets a UUID and is stored in a structured form that can be converted to the required e-invoice format.
- An **outbox** table (in the P1 schema) queues documents for transmission when internet is available, with status, retries and responses stored.
- **ARTÉPOOL's go-live date is pending from the accountant** (configurable setting). It may move the integration earlier than P4.

---

## 11. Hardware (to be confirmed by model)

| Device | Notes |
|---|---|
| Main Server PC | Reliable desktop, SSD, ≥16 GB RAM, UPS, BitLocker |
| Client PCs | Windows 10/11 |
| Thermal receipt printer | 80 mm, ESC/POS (Epson TM-T20III / TM-T82 or compatible), with drawer kick port ([0055](docs/decisions/0055-thermal-printer-esc-pos.md)) |
| Cash drawer | RJ11/RJ12, compatible with the printer |
| Barcode scanner | USB keyboard-emulation |
| Label printer | For barcode labels |
| A4 printer | Invoices, statements, reports |
| Backup drive | External drive or second PC |

Exact models must be chosen before Phase 1 POS work (milestone M6) so they can be tested during development.

---

## 12. Non-functional requirements

| Area | Target |
|---|---|
| POS speed | Item search/scan result < 300 ms; sale completion < 2 s |
| Concurrency | Many terminals selling at once with no duplicate numbers and no stock race conditions |
| Reliability | Power loss at any moment never leaves partial transactions |
| Test coverage | All money, VAT, stock and numbering logic covered by automated tests |
| Maintainability | Code in the private GitHub repository `artepool-erp`; documented setup, backup and restore procedures |

---

## 13. Phases and acceptance criteria

| Phase | Scope | Done when |
|---|---|---|
| **P1 — Core** | Architecture, database, migrations, security, users/roles/audit, master data, inventory, quotations, invoices (POS- and INV-), advance/progress payment tax invoices, credit notes, POS, cash drawer and shifts, **automatic double-entry postings (ledger core)**, backups, i18n | A full day of real-style sales on 2+ terminals reconciles exactly: stock, cash count, invoices, VAT, journals and audit chain all verified. A backup is restored successfully to a test database. |
| **P2 — Money** | Purchasing, suppliers, expenses, accounting screens, reports, VAT return, quarterly VAT export package and annual archive, dashboard | The accountant reproduces a month's VAT return and P&L from the system without manual fixes |
| **P3 — Operations** | Pool profiles, maintenance/cleaning contracts, visits, technician stock, service jobs, construction projects | One real contract, one service job and one project run end to end and bill correctly |
| **P4 — Extensions** | E-invoicing integration (may move earlier, depending on the go-live date), WhatsApp/email sending, promotions, loyalty, multi-warehouse UI, standby server | Each feature accepted individually |

Each phase ends with automated tests passing, a security review, an accountant review (P1–P2) and a written changelog.

---

## 14. Open questions

| # | Question | Status |
|---|---|---|
| 1 | Tax invoice layout and chart of accounts | Invoice content decided (10.2). **Chart of accounts and posting map: pending accountant review** ([0018](docs/decisions/0018-chart-of-accounts-and-posting-map.md)). |
| 2 | E-invoicing obligations and dates | Approach decided (ASP via API). **Go-live date: pending accountant** ([0019](docs/decisions/0019-einvoicing-via-accredited-provider.md)). |
| 3 | Hardware models (printer, drawer, scanner, label printer) | Receipt printer type decided (standard 80 mm ESC/POS, drawer on the printer, [0055](docs/decisions/0055-thermal-printer-esc-pos.md)); the exact model is bought later and checked with the manual hardware test checklist |
| 4 | Existing data to migrate (items, customers, opening balances) and its format | Open: needed before go-live (Excel import templates are provided in P1) |
| 5 | Whether retention (withholding) is used in construction contracts | Open: needed before P3 |
| 6 | Custom UI reference designs | Open: to be supplied at implementation time |

---

## 15. Change log

| Version | Date | Change |
|---|---|---|
| 1.10 | 2026-10-14 | M4b decisions 0064–0067: print designer with locked tax fields per document type (seller address on every tax invoice, customer address on full tax invoices; a full tax invoice needs the customer's address); company bank accounts with UAE IBAN check; customer PO number on A4 invoices and quotations; no QR code until e-invoicing. |
| 1.28 | 2026-10-19 | M6 approved in five parts: backups, installer + first-run setup wizard (0092), adding the cashier (0094), cashier Windows account hardening, owner's laptop on the LAN (0094); remote access dropped for Phase 1 (0093, 0084 deferred). |
| 1.27 | 2026-10-19 | Decision 0091: the kiosk lock is off while the owner is signed in on the POS PC; the owner code on the lock screen lifts it for 15 minutes. |
| 1.26 | 2026-10-19 | Decisions 0082–0089 accepted with the owner's answers (no shell replacement; owner code unlock at most 5 minutes; Tailscale with ACLs; dedicated Google account; banner "القفل متوقف"); decision 0090: POS idle behaviour. |
| 1.25 | 2026-10-18 | Proposed decision 0089: a per-PC "Kiosk lock" switch, owner only, stored on the server. |
| 1.24 | 2026-10-18 | Proposed decisions 0082–0088: app mode by device kind and POS kiosk mode; owner-only kiosk unlock; remote access through a private VPN only; server on the POS PC; backups to Google Drive encrypted with age; growth to more cashiers and drawers; no cloud database in Phase 1, outbox for a Phase 2 mobile dashboard. |
| 1.23 | 2026-10-18 | Decision 0081: the owner dashboard (sales, VAT, profit, cash, receivables, stock). |
| 1.22 | 2026-10-18 | Decision 0080: the owner sees the expected cash on "My shift"; drop alerts clear themselves. |
| 1.21 | 2026-10-18 | Decision 0079: the idle screen lock can be turned off per kind of PC; off on every PC. |
| 1.20 | 2026-10-18 | Decision 0078: the owner (only) may be remembered on POS PCs too. |
| 1.19 | 2026-10-18 | Decision 0077: the 2-step code once per PC; the PC is remembered until the password changes. |
| 1.18 | 2026-10-18 | Decision 0076: logo in the middle on bilingual A4 documents gives a letterhead (Arabic right, logo centre, English left). |
| 1.17 | 2026-10-17 | Decision 0075: the thermal receipt can have its own logo, separate from the company logo on A4 documents. |
| 1.16 | 2026-10-17 | Decision 0074: supervisor approvals with the approver's one-time 2-step code instead of a PIN. |
| 1.15 | 2026-10-17 | Decision 0071 revised: no name/address fields on A4 invoices; full when the customer is registered or has an address on file, else simplified. |
| 1.14 | 2026-10-17 | Decision 0072: an issued A4 invoice is cancelled or edited with the owner's approval, through a full credit note (refund at once) and, for edits, a new draft. |
| 1.13 | 2026-10-17 | Decision 0071: A4 invoices are always full tax invoices (the cash customer's name and address typed); reprints use today's design with unchanged content. |
| 1.12 | 2026-10-17 | Decision 0070: receipts print on an ESC/POS thermal printer or on any printer through its Windows driver; new receipt look with a separator between items. |
| 1.11 | 2026-10-17 | Decision 0069: stuck shifts closed from another PC by the owner or the accountant; the drawer moves with a re-enrolled PC; no revoking a PC with an open shift. |
| 1.9 | 2026-10-13 | Decision 0063: A4 cash taken by a cashier on their open shift goes into the drawer; A4 invoices shown in the shift's sales (POS, A4, total) but never in its expected cash. |
| 1.0 | 2026-10-06 | Initial approved scope for Phase 1 planning |
| 1.1 | 2026-10-06 | Applied owner and accountant decisions 0001–0019: confirmed stack; separate repository; POS oversell with approval; one cashier per shift; cart removals logged without approval; one recount with approval; no code-signing for now; POS silent printing and separate A4 section; VAT per line; invoice format by VAT registration; POS-/INV- series; discounts net per line; VAT on advance/progress payments; 4-decimal unit precision and no cash rounding; defective held at cost; monthly lock; quarterly VAT export and annual archive; chart of accounts by line of business (pending review); e-invoicing via accredited provider (go-live pending). Ledger core moved into P1. |
| 1.2 | 2026-10-07 | Phase 1 plan approved. Owner confirmed: VAT only on payments received before an invoice is issued; a 1-fils difference per movement is acceptable while the books match stock exactly; reprints marked "Copy" by default (setting); other document prefixes approved as defaults. Development moves to the owner's Windows PC after M0. |
| 1.3 | 2026-10-07 | Added the print designer (9.6a, decision 0020): customisable, versioned print templates with locked tax fields, in Phase 1. UI design reference v2 (simple style) in `design/`. |
| 1.4 | 2026-10-08 | M2 decisions 0031–0037:<br>• Excel import all or nothing after a check<br>• one sale price per item with a "price includes VAT" switch, net/VAT/total on every invoice, required customer type (price levels ready for later)<br>• four fixed UAE VAT categories with owner-only rate changes<br>• screen placement<br>• fiscal year January–December, with the chart provisional until the accountant approves<br>• customers start as cash, and credit is a permissioned, audited change<br>• master-data rules for codes, phones, TRNs and the logo |
| 1.5 | 2026-10-11 | Decisions 0038–0039: the item purchase price (without VAT, owner only, copied onto each sale) and the owner reports dashboard (four figures, date range, net profit after expenses). |
| 1.6 | 2026-10-11 | M3 decisions 0040–0044: stock cost visible to owner and accountant only; adjustment approval above 500.00 AED; opening stock by the owner only; barcode label sizes (list + custom); blind full counts and one warehouse in Phase 1. |
| 1.8 | 2026-10-13 | M4 follow-ups 0053–0054 (item-window quantity; no approval for stock adjustments). M5 decisions 0055–0062: ESC/POS 80 mm printers with the drawer on the printer; count denominations down to 0.05 plus "other amount"; cash drop alert at AED 3,000; over/short accepted by owner or accountant with a repeated-variance alert; POS discounts and prices as A4 (cashier 5%, price change always approved, oversell stays approved); POS returns as credit notes refunded from the open shift; card amount + approval code only; receipts in Arabic and English, cash customer by default. |
| 1.7 | 2026-10-12 | M4 decisions 0045–0052: Quotations and Receipts as their own sections; unpaid invoices for cash customers need approval; office cash to Cash in safe; cheques paid on receipt; quotations valid 15 days; print designer screen as M4b; customer opening balances by the owner only; payments settle the oldest invoices first. |
