# M5 — Point of sale (POS), shifts and the cash drawer: task plan

| | |
|---|---|
| **Status** | **Approved** (2026-10-13), with the owner's answers recorded as decisions [0055](../decisions/0055-thermal-printer-esc-pos.md)–[0062](../decisions/0062-pos-receipt-and-customer.md) |
| **Date** | 2026-10-13 |
| **Milestone** | M5 of the [Phase 1 plan](../phase-1-plan.md) |
| **Design reference** | [`03-pos.html`](../../design/screens/03-pos.html) (the POS), [`04-payment.html`](../../design/screens/04-payment.html) (payment), [`08-shift-close.html`](../../design/screens/08-shift-close.html) (shift close), [`10-thermal-receipt.html`](../../design/screens/10-thermal-receipt.html) (the receipt) |
| **Decisions already taken** | [0003](../decisions/0003-pos-oversell-with-approval.md) oversell with approval · [0004](../decisions/0004-one-cashier-per-drawer-shift.md) one cashier per drawer · [0005](../decisions/0005-cart-removals-logged-without-approval.md) cart removals logged · [0006](../decisions/0006-one-recount-with-supervisor-approval.md) one recount with approval · [0008](../decisions/0008-printing-pos-silent-a4-section.md) silent thermal printing |
| **Where it runs** | Same as M4: built and tested here; the Windows app is built by GitHub Actions. **The real printer and drawer can only be tested on your PC.** |

## Goal (in plain words)

After M5, the counter can sell:

- **The POS screen** (only on PCs enrolled as POS, cashier signs in with the 4-digit PIN):
  - fast search and barcode scan, item cards and categories;
  - cart with quantities;
  - removing a line before payment needs no approval, but is written to the audit log (0005);
  - hold a cart and resume it later.
- **Payment:**
  - cash, card or several together (split);
  - the change is worked out;
  - the sale is a `POS-` tax invoice. Stock, payment, journal entry and audit are saved in one transaction.
- **Receipt:** the 80 mm thermal receipt prints **silently**, with no print dialog (0008). The drawer opens only when there is cash in the payment.
- **Selling beyond stock:** a supervisor approves with their PIN. The sale goes through and an "oversell" adjustment waits for the storekeeper's review (0003).
- **Shifts (one cashier per drawer, 0004):**
  - open the shift with the opening float;
  - **paid-in / paid-out** with a reason;
  - **cash drop** to the safe, with an alert when the drawer holds too much cash;
  - **No Sale** (open the drawer without a sale): special permission and a reason, always logged;
  - **X report** in the middle of the shift (does not close it);
  - **closing (Z):**
    - **blind count** by denomination: the cashier doesn't see the expected amount until after counting;
    - over/short is shown;
    - **one recount only, with a supervisor's approval**; both counts are kept (0006);
    - the supervisor accepts the variance, and it posts to "Cash over/short" (6910);
  - over/short history per cashier, with an alert on repeated variances.
- **A4 copy:** a POS sale opens in the "Invoices (A4)" section and prints on A4 with the same number (0008).

## Tasks

| # | Task | Main files | Tests |
|---|---|---|---|
| T1 | **Migration 0022 — cash events:** `cash.movements` (float, paid-in/out, drop, sale cash, refund); `cash.drawer_events` (no-sale, drawer kick); variance acceptance on the shift; the shift summary view; journal links (posting map rows 16–19); settings (drop alert amount, variance alert rule); denominations | `db/migrations/0022_cash_events.sql` | Database tests: only the shift's cashier; movements only on an open shift; cash on hand = float + cash sales − refunds ± movements; immutable after close |
| T2 | **POS sale API:** one request = the `POS-` document + lines + split payment + cash movement + stock + journal + audit, idempotent (a retry after a network drop never sells twice); oversell with approval → pending oversell adjustment; held carts; cart events (removals) written to the audit log and linked to the invoice | `apps/server/src/modules/pos/*` | Integration: another user can't sell on the shift; oversell without approval refused, with approval pending and stock never negative; idempotent retry; split tender |
| T3 | **Shift API:** open, X report, paid-in/out, drop, No Sale, close with blind count, recount with approval, Z report, variance acceptance (journal row 19), history and alerts | `apps/server/src/modules/cash/*` | Expected amount hidden until counted; a second recount refused; a recount without approval refused; Z report shows both counts |
| T4 | **Thermal receipt:** the receipt laid out from design 10 (simplified or full, Arabic / English / both), drawn to an image in the app, turned into ESC/POS raster; Rust sends it RAW to the Windows printer (silent) and kicks the drawer; printer choice per PC in Settings → Devices | `apps/desktop/src/features/pos/receipt/*`, `apps/desktop/src-tauri/src/print.rs` | Snapshot tests of the receipt image (ar / en / both); the ESC/POS bytes; Rust tests of the RAW sender |
| T5 | **POS screen** (design 03/04): keyboard and scanner first, cart, cash customer by default (another customer for a full invoice), payment dialog with split tender and change, hold / resume, oversell approval, print | `apps/desktop/src/features/pos/*` | Screen tests (Arabic RTL + English) |
| T6 | **Shift screens** (design 08): open, paid-in/out, drop, No Sale, X report, blind count, recount, Z report (thermal + A4), variance acceptance for the supervisor, history | `apps/desktop/src/features/shifts/*` | Screen tests |
| T7 | **A4 copy of a POS sale** in the Invoices (A4) section, same number | `features/invoices` | Screen test |
| T8 | Playwright flows (sale, oversell, shift close with recount), screenshots, docs, PR | `apps/desktop/e2e/pos.spec.ts` | Arabic + English |

## Done when

- All tests pass here and in GitHub.
- **By hand (on your PC with the printer):**
  - Open a shift with a float of 500.
  - Sell two items with cash: the receipt prints by itself and the drawer opens.
  - Sell an item with 0 in stock: a supervisor PIN is asked, the sale goes through, and the storekeeper sees "pending review".
  - Close the shift and type a wrong count: you see the variance. Recount with a supervisor: both counts appear on the Z report.

## Questions for the owner

1. **Printer and drawer models:**
   - Do you already have the thermal printer? Tell us its make and model if so.
   - **Recommendation:** we build for standard ESC/POS 80 mm printers (Epson TM-T20/T82 and compatible, which most are). You'll test it on your PC, since there is no printer here.
2. **Denominations for the blind count:**
   - **Recommendation:** notes 1000, 500, 200, 100, 50, 20, 10, 5 and coins 1, 0.50, 0.25 AED.
   - The cashier types how many of each, and the total is worked out.
3. **Cash drop alert:** **recommendation:** when the drawer holds more than **3,000 AED** (a setting you can change).
4. **Accepting the variance:**
   - **Recommendation:** the owner or the accountant accepts the shift's over/short.
   - It posts to "Cash over/short" (6910).
   - An alert shows when the same cashier has a variance above **20 AED** three times in 30 days. Both numbers are settings.
5. **Oversell at the POS:**
   - Decision 0003 says selling beyond stock needs a supervisor. You removed approvals from stock adjustments (0054).
   - Should **selling beyond stock** keep the supervisor approval?
   - **Recommendation: keep it**, because it protects the stock figures, and the storekeeper reviews it afterwards.
6. **Discounts and price changes at the POS:**
   - **Recommendation:** same rules as the A4 invoice: each role has a discount limit, and above it, or for a changed price, a supervisor approves.
   - Or do you prefer the cashier can't discount or change prices at all?
7. **Returns at the POS:**
   - **Recommendation:** a "Return" button at the POS makes a credit note for the sale.
   - The money is paid back from the same shift's drawer, so the shift adds up.
   - Who may do it: the cashier with a supervisor's approval.
8. **Card payments:**
   - **Recommendation:** the card machine is separate (not connected). The cashier picks "Card" and types the amount and the approval number from the machine slip.
   - The card number is never stored.
9. **Receipt language:** **recommendation:** Arabic and English together on every receipt (a setting allows only one).
10. **Customer at the POS:** **recommendation:** the cash customer by default. The cashier can pick a customer (or add one) when they want a full tax invoice with their TRN.
