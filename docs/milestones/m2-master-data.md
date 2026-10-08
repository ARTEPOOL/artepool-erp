# M2 — Master data and chart of accounts: task plan

| | |
|---|---|
| **Status** | **Approved** (2026-10-08) with the owner's changes to pricing and VAT, recorded as decisions [0031](../decisions/0031-excel-import-all-or-nothing.md)–[0037](../decisions/0037-master-data-defaults.md) |
| **Date** | 2026-10-08 |
| **Milestone** | M2 of the [Phase 1 plan](../phase-1-plan.md) |
| **Design reference** | [`design/screens/07-items-stock.html`](../../design/screens/07-items-stock.html), [`design/screens/14-customers.html`](../../design/screens/14-customers.html), [`design/screens/13-settings.html`](../../design/screens/13-settings.html) (Company, VAT & numbering), tokens and components in [`design/`](../../design/) |
| **Where it runs** | Same as M1: server, database and screens are built and tested in this cloud environment (Chromium + Playwright). The Windows app is built by GitHub Actions on a Windows machine. |

## Goal (in plain words)

After M2:

- **Company details:** the owner enters the details that every tax invoice will print (names, TRN, address, logo).
- **Items:** you create products kept in stock, services (labour, visits) and kits made of other items. Items have barcodes and one sale price to 4 decimals, with a "Price includes VAT" switch.
- **People:** you create customers (Individual / Contractor / Company; VAT-registered with a TRN, or not; cash, or credit given by an allowed person), suppliers and technicians.
- **Lists:** you set up payment methods, the warehouse, lines of business and the reasons used later for stock and cash.
- **Accounts:** the provisional chart of accounts is loaded and editable. You choose which account each event uses (VAT, receivables, inventory…).
- **Months:** monthly accounting periods exist and can be closed and locked.
- **Import:** you fill Excel templates with your existing items and customers, and the app checks them before importing.
- **Search:** Arabic names are found however the letters are typed (ة/ه, أ/ا/إ/آ, ى/ي).

There are still no stock movements, sales or journal entries in M2. They come in M3 to M5.

## How the work is delivered

- **Branch:** `m2-master-data`, one commit per task, with tests run after every task.
- **Pull request:** one pull request into `main` at the end, with screenshots (Arabic/English, light/dark) next to the design. CI must be green.
- **Decisions:** your answers to the questions below are recorded as decisions 0031–0037 in `docs/decisions/`.

## Tasks

| # | Task | Main files | Tests |
|---|---|---|---|
| T1 | **Migration 0008 — chart of accounts and periods:**<br>• `gl.accounts`, seeded with the provisional chart (1000–6990) from [`accounting/chart-of-accounts.md`](../accounting/chart-of-accounts.md). Headers cannot be posted to. A parent must be a header of the same type, and loops are refused.<br>• `gl.account_mappings`: the 12 event links (receivables, VAT output, inventory, cash over/short, …), seeded. They may point only to an active account that can be posted to.<br>• `gl.periods`: monthly with no overlaps. Status moves open → closed → locked, and **locked is final**. Seeded for the fiscal year plus 3 months ahead.<br>• An account cannot be deactivated while something uses it. | `db/migrations/0008_gl_core.sql` | **Database tests:**<br>• mappings refuse header and inactive accounts<br>• overlapping months and reopening a locked month are refused<br>• parent, type and loop rules<br>• audit, no-delete and grants (privileges test) |
| T2 | **Migration 0009 — master data and reason codes:**<br>• the 15 `md` tables (units, VAT categories, lines of business, item categories, items, barcodes, kit components, price levels, item prices, customers, suppliers, technicians, payment methods, warehouses, cash denominations) and `sys.reason_codes`<br>• seeds from [schema §15.3](../database-schema.md#153-other-seeds): VAT categories, units, 4 lines of business linked to 4100–4400 / 5100–5400, payment methods (1110 / 1150 / 1140 / 1160), AED notes and coins, warehouse `MAIN`, the `STANDARD` price level, the walk-in customer, reason codes<br>• **Rules kept in the database:**<br>  – TRN: 15 digits, required when VAT-registered<br>  – exactly one walk-in customer, which cannot be changed or deactivated<br>  – a barcode belongs to one active item only; one primary barcode per item<br>  – a kit cannot contain itself or another kit<br>  – one default price level and one default warehouse<br>  – exactly four VAT categories; only the owner changes a rate, with a reason ([0033](../decisions/0033-four-fixed-uae-vat-categories.md))<br>  – customers start as cash; credit changes need `customers.credit` and a reason ([0036](../decisions/0036-customers-start-as-cash.md))<br>  – an item's code never changes ([0037](../decisions/0037-master-data-defaults.md))<br>  – "gives change" only for cash<br>  – accounts used by payment methods and lines of business must be postable and of the right type<br>• search keys that ignore Arabic letter variants, with trigram indexes<br>• the two links M1 left open: PC → default warehouse, approval → reason code | `db/migrations/0009_master_data.sql` | **Database tests:**<br>• every rule above<br>• searching "مضخه ارضيه" finds "مضخة أرضية"<br>• audit, no-delete and grants |
| T3 | **Shared rules and server building blocks:**<br>• Zod contracts for every list and form<br>• **checks shared by the screens and the server:** TRN, UAE phone numbers (stored as `+971…`), codes, barcodes, 4-decimal prices (typing "12.5" stores `125000`), quantities<br>• **"Changed by someone else":** every edit sends the version it started from. If someone else saved in between, the server refuses with 409 and the screen offers to reload.<br>• **List helper:** search, filters, paging | `packages/shared/src/{contracts,masterdata}/*`, `apps/server/src/platform/*` | **Unit and property tests:**<br>• price parsing and display, including the VAT-inclusive/exclusive figure through the shared rounding helper<br>• phone and TRN checks<br><br>**Integration test:** optimistic locking |
| T4 | **Company and "VAT & numbering" API:**<br>• **Company details:** anyone signed in can read them; only the owner edits them ([0030](../decisions/0030-company-details-owner-only.md)). The logo must be PNG or JPEG, ≤ 512 KB, checked by its content rather than its file name.<br>• **VAT categories:** only the owner changes a rate, and the change applies to new documents only.<br>• **Numbering series:** shown to everyone with access. The prefix and start number can be changed by the owner only, and only before the first number is used ([0011](../decisions/0011-document-numbering-series.md)).<br>• **Periods:** list; close a month; reopen a closed month; lock a month (final, with confirmation). | `apps/server/src/modules/{company,settings,ledger}/*` | **Integration tests:**<br>• permission refusals<br>• TRN required when VAT-registered<br>• a locked month cannot reopen<br>• a series is fixed after its first number<br>• audit entries |
| T5 | **Chart of accounts API:**<br>• the account tree; add, edit, and deactivate with a reason (refused while the account is in use)<br>• event links: change the account used for each event<br>• lines of business: names and their revenue and cost-of-sales accounts | `apps/server/src/modules/ledger/*` | **Integration tests:**<br>• header and inactive accounts refused<br>• type rules<br>• permissions<br>• audit |
| T6 | **Items API:**<br>• **item types:** stock item, service, kit (a kit lists its components with quantities)<br>• **barcodes:** several per item with one primary; pack barcodes carry a quantity per scan<br>• categories (a tree) and units<br>• one sale price to 4 decimals with a "Price includes VAT" switch (stored per price level; only `STANDARD` now)<br>• search by name in either language, code or barcode<br>• deactivate with a reason | `apps/server/src/modules/items/*` | **Integration tests:**<br>• barcode uniqueness<br>• kit rules<br>• prices stored exactly<br>• Arabic search<br>• the item type is fixed after first use (check ready for M3/M4)<br>• permissions<br>• audit |
| T7 | **Customers, suppliers and the other lists API:**<br>• **Customers:**<br>  – VAT registration + TRN<br>  – phone and TRN unique<br>  – walk-in customer protected<br>  – customer type (Individual / Contractor / Company)<br>  – cash or credit: payment terms and credit limit only with `customers.credit` and a reason<br>  – deactivate with a reason<br>  – export to Excel (`data.export`, written to the audit log)<br>• **Other lists:**<br>  – suppliers<br>  – technicians (optionally linked to a user)<br>  – payment methods<br>  – warehouses (Settings → Devices gains a "default warehouse" per PC, shown only when there is more than one)<br>  – reason codes | `apps/server/src/modules/{customers,suppliers,technicians,payment-methods,warehouses,reasons}/*` | **Integration tests:**<br>• TRN rules<br>• exactly one walk-in customer<br>• duplicates refused<br>• permissions<br>• audit |
| T8 | **Excel import:**<br>• download a template (Arabic and English headers) for items, prices, customers and suppliers<br>• **steps:** upload → check (nothing is saved) → a row-by-row report in the app (row, column, problem) → import<br>• the import is all-or-nothing in one transaction ([0031](../decisions/0031-excel-import-all-or-nothing.md)). A file changed after the check must be checked again.<br>• **limits:** `.xlsx` only, ≤ 5 MB, ≤ 5,000 rows<br>• every import is recorded in `sys.import_batches` and the audit log<br>• new library: `exceljs` (reads and writes `.xlsx`) | `apps/server/src/modules/imports/*` | **Integration tests:**<br>• one bad row → report, nothing imported<br>• importing the same file twice → duplicates reported<br>• a 5,000-row file finishes in reasonable time<br>• permissions (`data.import` plus that list's own permission) |
| T9 | **Items screen (design 07):**<br>• list with search (F2), category filters, "To reorder" and "Inactive"<br>• **item form, in the design's style:**<br>  – type<br>  – barcodes<br>  – kit components<br>  – one sale price with the "Price includes VAT" switch (the other VAT figure shown underneath)<br>  – line of business<br>• deactivate with a reason<br>• import dialog with the check report | `apps/desktop/src/features/items/*` | **Component tests and Playwright:**<br>• create a kit<br>• Arabic letter-variant search<br>• "changed by someone else"<br>• deactivate with a reason |
| T10 | **Customers screen (design 14) and Suppliers screen (same style):**<br>• list, search by name, phone or TRN, filters<br>• form with customer type, the VAT switch revealing the TRN, and cash/credit<br>• the walk-in customer shown as locked<br>• import and export | `apps/desktop/src/features/{customers,suppliers}/*` | **Playwright:**<br>• VAT-registered needs a TRN<br>• walk-in customer locked<br>• duplicate phone message |
| T11 | **Settings (design 13):**<br>• **Company** (owner only)<br>• **VAT & numbering:** numbering series, accounting periods, and e-invoicing shown as "Waiting for accountant"<br>• a new **Lists** section: units, item categories, VAT categories, payment methods, warehouses, technicians, lines of business, reason codes | `apps/desktop/src/features/settings/{company,tax,lists}/*` | **Playwright:**<br>• the owner edits the company details; the accountant does not see them<br>• close and lock a month |
| T12 | **Accounting screen (new, same style):**<br>• chart of accounts as a tree<br>• event links | `apps/desktop/src/features/accounting/*` | **Playwright:**<br>• linking an event to a header account is refused |
| T13 | **CI and docs:**<br>• Playwright flows in Arabic/light and English/dark<br>• screenshots<br>• decisions 0031+<br>• `CLAUDE.md`, PRD, schema, changelog, Windows guide<br>• pull request | `e2e/*`, `docs/*` | Green CI |

## Differences from the approved design (to keep the design honest)

1. **Stock parts of screen 07 come in M3:**
   - stock value, on hand, average cost, defective
   - "Adjust count", "Barcode labels"
   - recent movements

   Until then they are hidden, not shown empty.
2. **Balance parts of screen 14 come in M4:**
   - balance, overdue, aging, statement
   - the "Invoice" and "Receipt" buttons

   Until then they are hidden.
3. **The item form gains fields the design does not show:**
   - type (stock item / service / kit)
   - kit components
   - several barcodes
   - customer type and cash/credit on the customer form
   - line of business (optional)

   The PRD asks for all of these. They are built in the same style.
4. **Item codes and barcodes:**
   - Codes allow letters, digits, `.`, `_` and `-` (up to 32), as in the database rules. The design allows 2–20 capitals and digits.
   - Barcodes allow 3–64 letters and digits, so internal shop codes also work. The design allows 8–14 digits.
5. **Customer name:**
   - "Name" (in any language) is required.
   - "Name in the other language" is optional.

   The design requires an Arabic name, but many customers have an English name only.
6. **Settings → VAT & numbering:**
   - The single "VAT inclusive / exclusive" switch becomes a switch on each item ([0032](../decisions/0032-one-sale-price-with-vat-flag-and-customer-types.md)).
   - "New category" is replaced by the fixed UAE categories, shown under Lists ([0033](../decisions/0033-four-fixed-uae-vat-categories.md), [0034](../decisions/0034-master-data-screen-placement.md)).
   - Numbering shows the real series of [decision 0011](../decisions/0011-document-numbering-series.md) (`POS-000001`…). The design's samples include the year.
7. **Logo:** PNG or JPEG. SVG is not accepted, because an SVG file can carry hidden code.
8. **Emirate:** all seven emirates are offered.
9. **Screens the design does not include,** built in the same style ([0034](../decisions/0034-master-data-screen-placement.md)):
   - Suppliers
   - Settings → Lists
   - Accounting (chart of accounts, event links)
   - the import check report

## Small choices (approved by the owner, decision [0037](../decisions/0037-master-data-defaults.md))

- **Item codes:**
  - The app suggests the next free code.
  - A code cannot be changed after the item is created.
- **Customers:**
  - The phone number is required, and no two customers share one.
  - A TRN must be 15 digits starting with `100`, and no two customers share one.
- **Logo:** PNG or JPEG only (no SVG).
- **Later parts hidden:** stock and balance parts stay hidden until their milestones.
- **Never deleted:** nothing is hard-deleted; records are deactivated with a reason.
- **Prices:** up to 4 decimals, shown with 2 unless more were typed. A new price applies to new sales only.
- **Who does what:**
  - **Owner:** company details, VAT rates and numbering.
  - **Owner and accountant:** chart of accounts, event links, periods and customer credit.
  - **Cashier:** may add customers, always as cash.
  - All of these can be changed in Settings → Users & permissions, except the owner-only ones.

## Questions for the owner (answered 2026-10-08)

| # | Question | Answer |
|---|---|---|
| 1 | Excel import: skip bad rows, or all or nothing? | **All or nothing**, with a full row-by-row report → [0031](../decisions/0031-excel-import-all-or-nothing.md) |
| 2 | Prices: two price lists? | **Changed by the owner:**<br>• one sale price per item with a "Price includes VAT" switch<br>• VAT 5% for all customers with no exceptions<br>• every invoice shows net, VAT and total<br>• a required customer type (Individual / Contractor / Company)<br>• tables ready for a second price level by customer type later, with no screen now<br>→ [0032](../decisions/0032-one-sale-price-with-vat-flag-and-customer-types.md) |
| 3 | VAT categories: fixed or free? | **Four fixed UAE categories.** Only the owner changes a rate; it applies to new documents only and is audited → [0033](../decisions/0033-four-fixed-uae-vat-categories.md) |
| 4 | Where the new screens go | **As proposed:**<br>• Suppliers and Accounting in the side menu<br>• Settings → Lists (with VAT categories) → [0034](../decisions/0034-master-data-screen-placement.md) |
| 5 | Fiscal year and chart of accounts | **January–December.** The chart stays provisional and editable until the accountant approves it, and go-live waits for that approval → [0035](../decisions/0035-fiscal-year-and-provisional-chart.md) |
| 6 | New customer defaults | **Cash with a zero credit limit.** Switching to credit is a permissioned, audited change → [0036](../decisions/0036-customers-start-as-cash.md) |

## Done when

- All tests pass here and in CI, including the Windows build.
- **By hand:**
  - Create an item "مضخة أرضية" and search for "مضخه ارضيه": it is found.
  - Import the sample Excel file containing one bad row: you see a clear row-by-row report, and nothing is imported.
  - Enter the company details, a kit and a VAT-registered customer with a TRN. Every change appears in the audit log.
