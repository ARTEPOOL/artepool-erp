# M3 — Inventory and the posting engine: task plan

| | |
|---|---|
| **Status** | **Awaiting the owner's approval** (questions at the end) |
| **Date** | 2026-10-11 |
| **Milestone** | M3 of the [Phase 1 plan](../phase-1-plan.md) |
| **Design reference** | [`design/screens/07-items-stock.html`](../../design/screens/07-items-stock.html) (stock tiles and columns, "Stock adjustment" dialog, "Barcode labels" dialog), tokens and components in [`design/`](../../design/) |
| **Where it runs** | Same as M2: built and tested in this cloud environment; the Windows app is built by GitHub Actions. |

## Goal (in plain words)

After M3:

- **Stock is real:** every item's quantity and value come from a ledger of movements, never typed over. The database refuses to let stock go below zero.
- **Opening stock:** you enter what you have on go-live day (by hand or from Excel), with its cost. If no cost is typed, the item's purchase price ([0038](../decisions/0038-item-purchase-price-owner-only.md)) is offered.
- **Average cost:** each item's cost is the weighted average of what came in, to 4 decimals; when the last unit leaves, exactly the remaining value leaves with it.
- **Adjustments:** more found, less found, broken goods moved to "defective", defective goods written off. Each one gets a number (`ADJ-…`), a reason, and, above a value, a supervisor's approval.
- **Stock counts:** a full or partial count (`CNT-…`); the differences become adjustments when the count is posted.
- **Books:** every stock event writes its journal entry automatically, in the same instant (the posting map rows 12–15 and 21). A month that is closed or locked accepts nothing. A journal viewer shows every entry.
- **Alerts:** items at or below their reorder level, and oversells waiting for the storekeeper's review (oversells themselves start with the POS in M5).
- **Labels:** barcode labels for items.

Sales, the POS and cash come in M4–M5. Expenses and the owner's profit dashboard come after them ([0039](../decisions/0039-owner-reports-dashboard.md)).

## How the work is delivered

- **Branch:** `m3-inventory-ledger`, one commit per task, tests after every task.
- **Pull request:** one into `main` at the end, with screenshots (Arabic/light, English/dark). CI green.
- **Decisions:** your answers below become decisions 0040+.

## Tasks

| # | Task | Main files | Tests |
|---|---|---|---|
| T1 | **Migration 0011 — inventory** ([schema §8](../database-schema.md#8-schema-inv)):<br>• `inv.movements` (append-only ledger; every movement has a warehouse), `inv.balances` (written only by the trigger), `inv.adjustments` + lines, `inv.counts` + lines<br>• the trigger `inv.apply_movement()`: average cost in 4 decimals, the exact remaining value on the last unit, books that always equal the rounded stock value, **stock below zero refused** (`STOCK_INSUFFICIENT`)<br>• movements dated in an open month only | `db/migrations/0011_inventory.sql` | **Database tests:** the worked example (10 × 1.2345 → −3 → −7 → books 0.00); below zero refused; 20 parallel requests for the last 5 units → exactly 5 succeed; balances = Σ movements; audit, no-delete, grants |
| T2 | **Migration 0012 — journal entries** ([schema §11.4–11.5](../database-schema.md#114-gljournal_entries-append-only)): `gl.journal_entries` (`JV-`, gapless) + `gl.journal_lines`; balanced or refused at commit; a document can never be posted twice; closed or locked month refused; only active, postable accounts; customer required on control accounts | `db/migrations/0012_gl_journals.sql` | **Database tests:** unbalanced refused; double posting refused; locked month refused; header/inactive account refused |
| T3 | **The posting engine** (server, table-driven): reads the accounts from the event links ([0018](../decisions/0018-chart-of-accounts-and-posting-map.md)), never hard-coded; one entry per stock document, in the same transaction as the movements and the audit | `apps/server/src/modules/ledger/posting/*` | **Golden test per stock row** of the posting map (12, 13, 14, 15, 21); changing an event link changes the next posting only |
| T4 | **Adjustments API:** opening stock, increase, decrease, move to defective, write-off; draft → posted (number at posting); reason required; approval above the threshold (setting `inventory.adjustment_approval_threshold_fils`, today 500.00 AED); a posted adjustment never changes (a mistake is corrected by another adjustment) | `apps/server/src/modules/inventory/*` | **Integration tests:** permissions (`stock.adjust`, `stock.defective`, `stock.write_off`, `stock.adjust_over_threshold`); approval; numbering gapless; books match |
| T5 | **Opening stock from Excel:** item code, warehouse, quantity, unit cost (empty → the item's purchase price, if the person may use it); check first, then all rows or none ([0031](../decisions/0031-excel-import-all-or-nothing.md)) | `apps/server/src/modules/imports/*` | One bad row → nothing posted; costs exact to 4 decimals |
| T6 | **Stock counts API:** draft → counting (the system quantity is frozen at that moment) → posted; movements during the count are taken into account; differences need a reason; one adjustment entry per count | `apps/server/src/modules/inventory/counts*` | Variance = counted − (frozen + moved since); approval above threshold; books match |
| T7 | **Oversell review API** ([0003](../decisions/0003-pos-oversell-with-approval.md)): list pending, mark reviewed with a note (`stock.oversell_review`). The POS creates them in M5. | `apps/server/src/modules/inventory/*` | Pending → reviewed only; note required |
| T8 | **Journal viewer and periods API:** list and filter entries (date, source, account), open one entry with its lines and its source document; trial balance by account for a date range | `apps/server/src/modules/ledger/*` | Permissions (`ledger.view`); totals |
| T9 | **Screens — Items & stock (design 07):** the stock tiles (stock value, to reorder, defective) and columns (average cost, on hand); per-item stock card (quantity and value per warehouse and status, movement history); "To reorder" filter; the **Stock adjustment** dialog; **Opening stock** (form + Excel); **Stock count** screens (list, count entry, post) | `apps/desktop/src/features/{items,inventory}/*` | Component tests + Playwright |
| T10 | **Screens — Accounting:** journal viewer and entry detail, trial balance; oversell review list; alerts on the dashboard (to reorder, pending reviews) | `apps/desktop/src/features/{accounting,inventory,dashboard}/*` | Component tests + Playwright |
| T11 | **Barcode labels** (design 07 dialog): label size, number of labels, price with VAT; printed through the print dialog (see question 4) | `apps/desktop/src/features/items/labels*` | Layout test, both languages |
| T12 | **Default warehouse per PC** (moved from M2): Settings → Devices, shown only with more than one warehouse | `apps/desktop/src/features/settings/devices/*` | Component test |
| T13 | **CI and docs:** Playwright flows (Arabic/light, English/dark), screenshots, decisions, `CLAUDE.md`, PRD, schema, changelog, pull request | `e2e/*`, `docs/*` | Green CI |

## Done when

- All tests pass here and in CI.
- **By hand:**
  - Opening stock of 10 units at 1.2345 AED → stock value 12.35, average 1.2345.
  - Remove 3, then the remaining 7 → the average stays 1.2345, and both the stock value and the books end at exactly 0.00.
  - Lock last month, then try an adjustment dated in it → refused.
  - Try to remove more than you have → refused, nothing changes.
  - Every adjustment and its journal entry appear in the audit log.

## Questions for the owner

1. **Who sees stock cost and value** (average cost column, stock value tile, values in adjustments and journal entries)? The default roles today: owner and accountant yes (`stock.view_cost`), storekeeper and cashier no. Decision 0038 made the *purchase price* owner-only, but the accountant needs inventory values for the books. **Recommendation:** owner and accountant see stock values and average cost; storekeeper and cashier see quantities only; the purchase price field stays owner-only.
2. **Approval threshold for adjustments:** an adjustment or count difference worth more than **500.00 AED** needs a supervisor's approval (design 07 and setting today). Keep 500?
3. **Opening stock:** entered once at go-live, dated the go-live day, from Excel or by hand, with a cost per item (empty → the purchase price). Its journal entry is "Inventory / Opening balance equity" (posting map row 21). **Recommendation:** yes, with the owner as the only one allowed to post opening stock.
4. **Barcode labels — which printer?** The design offers 38 × 25 mm and 50 × 30 mm labels. **Recommendation:** for now print them through the normal print dialog (works with a label printer installed in Windows, or on A4 label sheets); silent printing to a dedicated label printer comes with the hardware list before M5.
5. **Counting:** while counting, should the person counting see the system quantity? **Recommendation:** no ("blind count") for full counts, so the numbers are really counted; the quick single-item adjustment in design 07 keeps showing it.
6. **One warehouse for now?** Only `MAIN` exists; transfers between warehouses are planned for Phase 3. **Recommendation:** keep it that way; everything is already stored per warehouse.
