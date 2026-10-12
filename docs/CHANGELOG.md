# Changelog

## M3 — Inventory and the posting engine (2026-10-12)

**In plain words:** stock is now real. The owner enters the **opening stock** once (by hand or from Excel), people **add, remove, move to defective and write off** stock with a reason, and **counts** compare the shelves with the system without showing the counter the expected number. Every stock change is a numbered document that also writes its **journal entry** in the same moment, so the books always equal the stock value to the fils. The accountant sees the **journal** and the **trial balance**. Barcode labels print in many sizes. Proven by 292 unit and screen, 376 integration and 46 browser tests.

- **Database:** migration 0011 (the stock ledger: movements, balances written only by the database, adjustments, counts, label sizes) and 0012 (journal entries `JV-`, gapless, balanced or refused, never posted twice, only in an open month).
- **Average cost (method A, decision 0038):** 4 decimals; the last unit takes exactly what is left, so 10 × 1.2345 → remove 3 → remove 7 ends at exactly 0.00. Stock below zero is refused; 20 people taking the last 5 units at the same moment → exactly 5 succeed.
- **Who sees what (decisions 0040–0042):** cost and values only for the owner and the accountant; above 500.00 AED a supervisor approves with their PIN; opening stock is the owner's alone.
- **Counts (decision 0044):** blind while counting; the reviewer sees system quantity, movements during the count and the difference, gives a reason per difference, and posts one document and one journal entry.
- **Journal and trial balance:** filter by date, source and account; open an entry with its lines, its source document and who posted it; the inventory accounts equal the stock books (tested).
- **Items & stock (design 07):** stock tiles and columns, the "To reorder" filter, a stock card per item with its movements, the stock adjustment dialog, buttons to opening stock, counts and oversell reviews.
- **Barcode labels (decision 0043):** 8 preset sizes and A4 sheets, plus custom sizes in Settings → Lists; printed through the print dialog.
- **Also:** the default warehouse per PC in Settings → Devices (shown with more than one warehouse); dashboard alerts for items to reorder and oversells waiting for review; names instead of user numbers on journal entries and adjustments.
- **Oversells:** the review page is ready; the POS creates them in M5.

## M2b — Item purchase price (2026-10-11)

**In plain words:** every stock item and service can now have a **purchase price**, typed on the item screen or in the Excel template. It is without VAT, and **only the owner** sees or changes it. Next to the sale price the owner sees the **profit per unit**. A kit's cost is worked out from its components. This is the data the owner's profit reports (decision 0039) will use once sales exist.

- **Database:** migration 0010 (services may have a cost, kits never; the database refuses a change without the new owner-only permission `items.cost`). The planned later migrations move up by one (inventory is now 0011).
- **Never leaks:** the cost is not in item lists, to the cashier, the storekeeper or the accountant; Excel import of the column is refused for anyone else.
- **Decisions:** [0038](decisions/0038-item-purchase-price-owner-only.md) purchase price; [0039](decisions/0039-owner-reports-dashboard.md) the owner's reports dashboard (four figures, date range, net profit after expenses).
- **Expenses (rent, bills):** approved, but they need the ledger's journal tables (M3), so they are built after M3, not before.

## M2 — Master data and chart of accounts (2026-10-11)

**In plain words:** the owner can now enter everything the shop is built on: the company details printed on tax invoices, items with barcodes and one sale price (with a "Price includes VAT" switch), customers and suppliers, the short lists (units, categories, payment methods, warehouses, technicians, lines of business, reasons), the provisional chart of accounts with its event links, and the monthly accounting periods. Existing items and customers come in from Excel: checked first, then all rows or none. Nothing is ever deleted. Arabic and English, light and dark. Proven by 237 unit and screen, 339 integration and 42 browser tests.

- **Database:** migration 0008 (chart of accounts, event links, monthly periods kept 3 months ahead) and 0009 (master data, price levels, reason codes). Business rules live in the database and answer with a clear rule code the screens translate.
- **Prices and VAT (decisions 0032, 0033):** one sale price to 4 decimals per item, with "Price includes VAT"; the screens always show net, VAT and total, split or added through the shared rounding helper. Four fixed UAE VAT categories; only the owner changes a rate, with a reason, for new documents only. Ready for a second price level later, without building it now.
- **Items (design 07):** stock items, services and kits; barcodes with one main barcode and pack quantities; the code is suggested from the category and never changes; the type is fixed once used; search ignores Arabic letter forms ("مضخه ارضيه" finds "مضخة أرضية").
- **Customers (design 14) and suppliers:** customer type (Individual / Contractor / Company); VAT-registered customers need a TRN (15 digits starting with 100) and get a full tax invoice; phone and TRN are unique; new customers start as cash and only the owner or accountant gives credit, with a reason (decision 0036); the walk-in customer is locked; export to Excel is written to the audit log.
- **Settings:** Company (owner only; logo PNG/JPEG up to 512 KB, checked by content), VAT & numbering (series fixed after their first number, close / reopen with a reason / lock a month for good, e-invoicing waiting for the accountant), and the new Lists section.
- **Accounting:** the provisional chart as a tree (an account in use keeps its type and cannot be deactivated) and the event links, which accept only a suitable account. Go-live waits for the accountant's approval (decision 0035).
- **Excel import (decision 0031):** templates with Arabic and English headers; check first with a row-by-row report; then one transaction for all rows or none; a file changed after the check must be checked again.
- **Every save is protected against "changed by someone else"**: the screen offers to reload instead of overwriting.
- **Fixes found on the way:** Arabic counts now use every Arabic plural form (2 → صفّين, 3–10 → صفوف, 11–99 → صفًا), and the translation check requires them; a React key clash on the Users screen (user 3 next to role 3) is gone.

## M1 — Security core and app shell (2026-10-07)

**In plain words:** only enrolled PCs can talk to the server, over an encrypted connection; people sign in safely (password, cashier PIN on POS PCs, owner's phone code); and the owner manages users, PCs and the audit log in Settings — in Arabic and English, light and dark, matching the approved design. Proven by 164 unit, 260 integration, 26 Rust and 32 browser tests.

- **Database:** migration 0006 adds trusted PCs; migration 0007 makes company details owner-only (decision 0030: the accountant keeps the audit log). The chart of accounts moves to 0008, master data to 0009.
- **Enrolling a PC:** a 10-minute, one-time code that also proves the server is genuine; the PC then trusts only the ARTÉPOOL certificate (TLS 1.3) and keeps its own key in Windows Credential Manager; the key renews itself every year.
- **Signing in:**
  - passwords of 10+ characters, common ones refused, 5 wrong tries lock the account for 15 minutes;
  - cashiers pick their name and type a 4-digit PIN, on POS PCs only; weak PINs refused; blocked after 5 wrong tries until the owner unblocks it;
  - the owner adds a 6-digit code from the phone; 10 one-time recovery codes; an emergency reset on the server PC only;
  - a temporary password or PIN must be replaced at first sign-in;
  - idle screens lock (POS 5 minutes, office 15);
  - **"Trust this PC"** (decision 0027): after the phone code, the owner can skip it on their own PC for 30 days (never on POS PCs); it ends by itself on a new password or 2-step change, and the owner can end it in Settings → Devices;
  - **"Forgot your password?"** (decision 0028): the phone code and one recovery code let the owner choose a new password in the app, even while locked; every other session and trusted PC ends;
  - **last resort on the server PC** (decision 0029): `pnpm owner:reset-password` (reason, temporary password shown once, optional 2-step reset, audited); the owner then sees when and why on the "choose your own password" screen.
- **Every request is checked by the server:** the PC, the session, and a permission declared for every route (the server refuses to start otherwise). Saves are never done twice when retried.
- **Settings (design 13):** users (temporary code shown once, unlock, deactivate with a reason, reactivate — never deleted), roles and permissions (discount limits stored as whole numbers), PCs (new code, rename, revoke with a reason, who is trusted until when, end trust), and the audit log (chain check, filters, before/after, export).
- **The Windows app (Tauri):** one copy per PC; updates only with a valid signature (the key is created in M6); strict security policy.
- **CI:** Linux checks and tests, browser tests in both languages, Rust tests (also against the real server), and a Windows build that produces the installer.

## M0 — Foundations (2026-10-07)

**In plain words:** the invisible backbone is built and proven by 176 automatic tests. There are no screens yet; those come in M1.

- **Database safety rules:**
  - nothing can be deleted
  - nothing can be written without a known user
  - final records cannot change
  - every write is recorded in the audit diary
- **Tamper-evident audit diary:** each entry is sealed with a fingerprint chained to the previous one. A secret change made with full database access is caught at the exact entry (`pnpm demo:audit-tamper`).
- **Gapless numbering:** 13 series (`POS-`, `INV-`, `CN-`, `Q-`, `RCT-`, …). 50 simultaneous requests, some of them cancelled, still give 1, 2, 3… with no gaps or repeats.
- **Money calculator:**
  - integers only: fils, plus 4-decimal unit prices
  - VAT calculated per line
  - discounts spread exactly across lines
  - the same rounding rule in the app and in the database, proven by shared test cases
- **Safe database upgrade tool:** it refuses to run an upgrade file that was edited after use.
- **Users, roles and permissions:**
  - 5 default roles
  - 64 permissions, 11 of which a supervisor can approve once
  - the agreed role matrix
- **Settings:** 22 settings with the agreed defaults (oversell with approval, silent POS receipts, "Copy" on reprints, e-invoicing date pending).
- **Server core:** one transaction per business operation with automatic retry after a deadlock, strict time limits, no secrets in logs, and a `/health` check.
- **Tooling:** CI on GitHub runs everything on PostgreSQL 18. A step-by-step Windows setup guide is included.
