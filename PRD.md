# ARTÉPOOL ERP — Product Requirements Document (PRD)

**Version:** 1.0 (draft)
**Date:** 2026-10-06
**Owner:** Mohammed Yasser Al Huraidi (partner, ARTÉPOOL)
**Status:** Approved scope for Phase 1 planning

---

## 1. Overview

An **offline-first desktop system** for ARTÉPOOL to run invoicing, point of sale, inventory, cash management, services and accounting from computers in the company's own premises, with no dependency on the internet for daily work.

The system is **built for ARTÉPOOL's internal use** (not a commercial product for now), so there is no licensing, activation or per-device limit.

### 1.1 Business context

ARTÉPOOL is a swimming pool company headquartered in **Al Ain, Abu Dhabi, UAE**. It has four lines of business, all of which the system must serve:

| Line of business | What the system must support |
|---|---|
| Pool supplies retail (showroom) | POS, barcode sales, stock, cash drawer, promotions |
| Pool construction | Quotations, staged/progress billing, project cost vs. budget, project profitability |
| Pool maintenance | Service jobs, technicians, parts and labour, site visits |
| Pool cleaning | Recurring contracts, visit schedules, automatic recurring invoices |

### 1.2 Top priorities (in order)

1. **Database integrity** — the data must never be lost, corrupted or silently changed.
2. **Security** — only authorised people can do sensitive actions, and every action is traceable.
3. Correct UAE VAT handling and tax-ready reports.
4. Speed and simplicity at the counter.

---

## 2. Scope decisions (confirmed by the owner)

| Decision | Value | Design implication |
|---|---|---|
| Number of devices | **Open / unlimited** | Client–server architecture; no hard-coded limit on terminals or users |
| Warehouses | **One warehouse now, must support more later** | Every stock movement carries a `warehouse_id` from day one; UI hides warehouse selection while only one exists |
| Languages | **Arabic and English** | Full i18n from day one; RTL and LTR layouts; bilingual printed documents |
| UI design | **Fully custom**; reference designs will be provided at implementation time | Build on a theming layer (design tokens) so the visual design can be applied later without rewriting screens |
| Connectivity | **Offline-first** | All daily operations work with no internet. Internet is used only for optional cloud backup, WhatsApp sending and future e-invoicing sync |
| Platform | Windows 10/11 desktops | Desktop app, not a website |

---

## 3. Architecture

### 3.1 Recommended stack (to be confirmed in the first Claude Code planning session)

| Layer | Recommendation | Reason |
|---|---|---|
| Database | **PostgreSQL 16+** on one "Main Server" PC | Robust multi-user concurrency, ACID transactions, roles, WAL and point-in-time recovery, free |
| Backend | **Local API service** (TypeScript / Node.js) running as a Windows service on the Main Server | Single place for business rules and security; clients never touch the database directly |
| Clients | **Tauri 2 desktop app** with React + TypeScript | Small, fast, harder to tamper with than Electron |
| Client ↔ server | HTTPS (TLS) over the local network | Encrypted even on the LAN |
| Migrations | Versioned SQL migrations | Safe upgrades without data loss |

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

- The Main Server PC can also be used as a normal workstation.
- Clients find the server by a configured address (with optional auto-discovery on the LAN).
- If a client loses the connection, it shows a clear "server unreachable" state and never saves partial data.

### 3.3 Future-proofing

- **Standby server:** design so a second PC can hold a near-real-time replica and be promoted if the main one fails.
- **Multi-warehouse / branch:** schema-ready now, UI later.
- **E-invoicing (UAE):** see section 10.4. The schema must store invoices in a structured, transmittable form and include an outbox for later sync.

---

## 4. Non-negotiable database rules

These rules apply to every table and every feature.

| # | Rule | Detail |
|---|---|---|
| 1 | **No hard deletes of business records** | Invoices, payments, stock movements, journal entries, customers, items: never `DELETE`. Cancel via reversal documents (credit notes, reversing entries) or deactivate (`is_active = false`). |
| 2 | **Money as integers** | Store all amounts in the smallest unit (fils): `BIGINT`. 100.50 AED = 10050. No floating point anywhere in money math. |
| 3 | **Atomic transactions** | A sale, its stock deduction, its payment and its journal entry commit together or not at all. |
| 4 | **Double-entry ledger** | Every financial event posts balanced debit/credit lines to the general ledger. A DB constraint or check ensures each journal entry balances. |
| 5 | **Gapless sequential numbering** | Per document type (invoice, credit note, quotation, receipt…), allocated inside the transaction. No gaps, no reuse. |
| 6 | **Immutable posted documents** | Once an invoice is issued/posted it cannot be edited. Corrections only via credit/debit notes. |
| 7 | **Tamper-evident audit log** | Every create/update/status change records: user, device, timestamp (server time), entity, old value, new value, reason. Each row stores a hash of its content + the previous row's hash (hash chain). A verification tool reports any break in the chain. |
| 8 | **Constraints in the database** | Foreign keys, NOT NULL, CHECK constraints (e.g. quantities, statuses). The database rejects bad data even if the app has a bug. |
| 9 | **Period locking** | Closed accounting/tax periods cannot receive new postings or changes. |
| 10 | **Server time only** | All timestamps come from the server, stored in UTC, displayed in Asia/Dubai. Detect and log client clock tampering. |
| 11 | **Versioned migrations** | Every schema change is a numbered migration, tested on a copy of real data before release. |
| 12 | **Least-privilege DB roles** | The API connects with a role that cannot drop tables or alter the audit log. Owner/admin DB credentials are not stored on client PCs. |

---

## 5. Security requirements

| Area | Requirement |
|---|---|
| Disk | BitLocker on the Main Server and on any PC holding backups |
| Database | Sensitive columns encrypted; DB listens on LAN only; firewall allows only the API |
| Transport | TLS between clients and API |
| Passwords | Argon2id (or bcrypt) hashes; never stored or logged in plain text |
| Login | Lockout after repeated failures; auto-lock idle sessions; per-user PIN for quick cashier switching |
| Owner 2FA | TOTP (authenticator app) for owner/admin accounts — works offline |
| Roles & permissions | Granular permissions per action, not just per screen. Default roles: Owner, Accountant, Cashier, Technician, Storekeeper. Custom roles allowed. |
| Supervisor approval | Required (supervisor PIN + mandatory reason) for: discounts above the user's limit, refunds/credit notes, voiding, price override, "No Sale" drawer open, stock adjustments above a threshold |
| Audit | Every sensitive action is logged (see rule 7) and viewable by the owner |
| App integrity | Signed releases and signed updates; no secrets in client code |
| Ransomware resilience | At least one backup copy not continuously connected to the network |
| Data export | Exports (CSV/PDF) are permission-controlled and logged |

---

## 6. Backup and disaster recovery

| Requirement | Detail |
|---|---|
| 3-2-1 rule | 3 copies, 2 different media, 1 off-site |
| Local automatic backup | Hourly to a second PC or external drive |
| Off-site backup | Daily, **encrypted before upload**, to Google Drive / OneDrive when internet is available |
| Point-in-time recovery | WAL archiving so data can be restored to a specific minute |
| Restore tool | Built-in restore to a test database, plus monthly restore test reminder |
| Backup health | Dashboard shows last successful backup; alert if a backup fails or is older than the threshold |
| Hardware | UPS on the Main Server (documented requirement) |

---

## 7. Internationalisation (Arabic + English)

- **Every UI string** comes from translation files (`ar`, `en`). No hard-coded text in components.
- **Per-user language preference**; switching language switches layout direction (RTL ↔ LTR) instantly.
- **Bilingual master data:** items, categories, services and units have `name_ar` and `name_en`. Customers and suppliers have an optional second-language name.
- **Printed documents:** tax invoices, credit notes and quotations print **bilingual** (Arabic + English) by default; receipts and job cards configurable (Arabic, English or both).
- Numbers: Western digits (0-9) by default, configurable. Dates: Gregorian, format configurable.
- Search must work in both languages (and tolerate Arabic letter variants such as ا/أ/إ/آ, ة/ه, ى/ي).
- Fonts must render Arabic correctly on screen and on thermal printers.

---

## 8. UI and theming

- The final visual design is **custom**; the owner will supply reference designs at implementation time.
- Until then, build screens on a **design-token layer** (colors, typography, spacing, radius) and reusable components, so the custom design can be applied centrally.
- Counter screens (POS) must be fully usable by keyboard and barcode scanner; touch-friendly where possible.
- Every destructive or financial action shows a clear confirmation with the amount.

---

## 9. Modules

Phase tags: **[P1]** to **[P4]** (see section 13).

### 9.1 Users, roles and audit [P1]
- Users, roles, granular permissions, supervisor limits (max discount %, max discount amount).
- Audit log viewer with filters (user, date, entity, action) and hash-chain verification.

### 9.2 Master data [P1]
- Company profile: bilingual name, TRN, address, logo, contact details.
- Items: code, barcode(s), bilingual name, category, unit, cost (weighted average), price(s), VAT category, reorder level, active flag.
- Item types: stock item, service/labour, **bundle** (kit made of components).
- Customers (with TRN for VAT-registered customers), suppliers, technicians (no login needed), payment methods, warehouses.
- Bulk import from Excel templates.

### 9.3 Inventory [P1]
- Stock movements ledger (every in/out is a row; stock on hand is derived, never edited directly).
- **Moving weighted-average cost**, recalculated on each posted purchase.
- Stock count and adjustments with mandatory reason codes; threshold alerts.
- Low-stock alerts per item; out-of-stock handling at POS (configurable).
- **Defective stock bucket** for returned broken goods (separate from sellable stock).
- Bundles deduct their components.
- Barcode label printing.
- Multi-warehouse ready; transfers between warehouses [P3].

### 9.4 Sales documents [P1]
- **Quotation → Invoice** in one click.
- Invoice lifecycle: Draft → Issued (unpaid) → Partially paid → Paid. Draft does not count in revenue or stock.
- Partial payments, multiple payment methods per invoice (cash, card, bank transfer, cheque, custom).
- **Credit notes** with their own number, referencing the original invoice and reversing VAT; the original invoice is never changed.
- Negotiated discount on total, with staff limits and supervisor approval above the limit.
- Customer **statement of account** for any date range (PDF/print).
- Send PDF by WhatsApp/email when online [P4].

### 9.5 Point of Sale [P1]
- Fast item search and barcode scan, categories, cart, quantity edits.
- Split tender (cash + card + others).
- Thermal receipt (80 mm) and A4 invoice.
- Each sale creates an invoice and deducts stock in the same transaction.
- Hold/resume cart.

### 9.6 Cash drawer and shifts [P1]
- Drawer connected through the receipt printer (RJ11/RJ12 kick port), opened via ESC/POS command.
- **Open shift** with opening float.
- Drawer opens automatically only for sales with a cash component.
- **No Sale** open: special permission + reason, always logged.
- **Paid-in / paid-out** (petty cash, change float) with reason.
- **Cash drop** alert when cash in drawer exceeds a configurable amount.
- **X report** (mid-shift, no close).
- **Z report / shift close** with **blind count**: cashier enters counted cash (by denomination) without seeing the expected amount; system then shows over/short.
- Over/short history per cashier with alerts on repeated variances.
- Drawer-left-open alert where the hardware supports status reporting.

### 9.7 Purchasing and suppliers [P2]
- Purchase orders → goods received → supplier invoice.
- Supplier balances, payments, supplier statement.
- Reorder suggestions from low-stock levels.

### 9.8 Expenses and petty cash [P2]
- Expense entry with category, VAT (input tax), attachment (scanned receipt).
- Petty cash custody per employee.

### 9.9 Accounting [P2]
- Chart of accounts (UAE-appropriate default, editable).
- Automatic journal postings from all modules; manual journal entries with approval.
- Accounts receivable / payable with **aging** reports.
- Bank and cash accounts; basic bank reconciliation.
- Period close and lock.

### 9.10 Reports [P2]
- Profit & loss, sales by period/category/item/user, top items by revenue and margin.
- **VAT return report** (output VAT, input VAT, net payable) in the layout the accountant needs.
- Stock valuation, stock movement, low stock, defective returns.
- Cash/shift reports by cashier and tender.
- Export to PDF and Excel/CSV.

### 9.11 Maintenance and cleaning contracts [P3]
- **Pool profile per customer site:** location, size, volume, pump, filter, heater/chiller, build date, warranty.
- **Recurring contracts:** frequency, price, start/end, visits included, auto-generated recurring invoices, renewal alerts.
- **Visit schedule** per technician; visit report (chemical readings, work done, chemicals used, photos optional).
- **Technician van stock:** each technician as a mobile stock location; consumption at visits deducts from it.

### 9.12 Service jobs [P3]
- Job card: customer, site/equipment, reported issue, technician, promised date.
- Stages: Received → Diagnosing → Awaiting approval → In progress → Ready → Delivered.
- Parts and labour estimate → invoice in one click; parts deduct at billing.
- Printed job card with customer signature line.

### 9.13 Construction projects [P3]
- Project from an accepted quotation; budget by cost category.
- **Progress billing:** advance payment, milestone invoices, retention (if used), final invoice.
- Actual cost tracking (materials issued from stock, labour, subcontractors, expenses) vs. budget.
- Project profitability report.

### 9.14 Promotions and loyalty [P4]
- Percentage, fixed, buy-X-get-Y, category-wide promotions with validity dates.
- Optional loyalty points.

### 9.15 Owner dashboard [P2]
- Today's sales, cash position, receivables due, low stock, overdue visits/jobs, backup health.

---

## 10. UAE tax and compliance (verify all items with the accountant)

### 10.1 VAT
- Standard rate 5%, plus zero-rated and exempt categories configurable per item.
- Prices configurable as tax-inclusive or tax-exclusive.
- VAT calculated per line with a documented, consistent rounding rule.

### 10.2 Tax invoice content
Must include at least: "Tax Invoice" title (bilingual), supplier name, address and TRN, customer name, address and TRN (when VAT-registered), sequential invoice number, issue date, date of supply if different, item descriptions, quantities, unit prices, discounts, taxable amount, VAT rate and VAT amount per line and in total (in AED), and total payable. Simplified tax invoice format available where the law allows it. **Exact requirements to be confirmed with the accountant before the template is finalised.**

### 10.3 Record retention
- Default policy: **never delete**. Archive old periods but keep them queryable.
- The legally required retention period is to be confirmed with the accountant.

### 10.4 E-invoicing readiness
The UAE is introducing mandatory e-invoicing in phases. Because the system is offline-first:
- Every issued document gets a UUID and is stored in a structured form that can be converted to the required e-invoice format.
- An **outbox** table queues documents for transmission when internet is available, with status, retries and responses stored.
- Integration with an accredited service provider is a [P4] item; the schema for it is part of [P1].

---

## 11. Hardware (to be confirmed by model)

| Device | Notes |
|---|---|
| Main Server PC | Reliable desktop, SSD, ≥16 GB RAM, UPS, BitLocker |
| Client PCs | Windows 10/11 |
| Thermal receipt printer | 80 mm, ESC/POS, with drawer kick port |
| Cash drawer | RJ11/RJ12, compatible with the printer |
| Barcode scanner | USB keyboard-emulation |
| Label printer | For barcode labels |
| A4 printer | Invoices, statements, reports |
| Backup drive | External drive or second PC |

Exact models must be chosen before Phase 1 POS work so they can be tested during development.

---

## 12. Non-functional requirements

| Area | Target |
|---|---|
| POS speed | Item search/scan result < 300 ms; sale completion < 2 s |
| Concurrency | Many terminals selling at once with no duplicate numbers and no negative-stock race conditions |
| Reliability | Power loss at any moment never leaves partial transactions |
| Test coverage | All money, VAT, stock and numbering logic covered by automated tests |
| Maintainability | Code in a private GitHub repository; documented setup, backup and restore procedures |

---

## 13. Phases and acceptance criteria

| Phase | Scope | Done when |
|---|---|---|
| **P1 — Core** | Architecture, database, migrations, security, users/roles/audit, master data, inventory, quotations, invoices, credit notes, POS, cash drawer and shifts, backups, i18n | A full day of real-style sales on 2+ terminals reconciles exactly: stock, cash count, invoices, VAT and audit chain all verified; backup restored successfully to a test DB |
| **P2 — Money** | Purchasing, suppliers, expenses, accounting ledger, reports, VAT return, dashboard | Accountant reproduces a month's VAT return and P&L from the system without manual fixes |
| **P3 — Operations** | Pool profiles, maintenance/cleaning contracts, visits, technician stock, service jobs, construction projects | One real contract, one service job and one project run end to end and bill correctly |
| **P4 — Extensions** | E-invoicing integration, WhatsApp/email sending, promotions, loyalty, multi-warehouse UI, standby server | Each feature accepted individually |

Each phase ends with: automated tests passing, security review, accountant review (P1–P2), and a written changelog.

---

## 14. Open questions

1. Exact tax invoice layout and chart of accounts required by the accountant.
2. Current e-invoicing obligations and dates applicable to ARTÉPOOL.
3. Hardware models (printer, drawer, scanner, label printer).
4. Existing data to migrate (items, customers, opening balances) and its format.
5. Whether retention (withholding) is used in construction contracts.
6. Custom UI reference designs (to be supplied at implementation time).
