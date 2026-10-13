# M4 — Invoices (A4), Quotations and Receipts: task plan

| | |
|---|---|
| **Status** | **Done** (2026-10-12), awaiting the owner's merge of the pull request. See [Delivered](#delivered). Approved on 2026-10-12: all recommendations accepted, with Quotations and Receipts as their own sections; recorded as decisions [0045](../decisions/0045-sales-sections-in-the-side-menu.md)–[0052](../decisions/0052-payment-allocation-oldest-first.md) |
| **Date** | 2026-10-12 |
| **Milestone** | M4 of the [Phase 1 plan](../phase-1-plan.md) |
| **Design reference** | [`design/screens/05-a4-invoices.html`](../../design/screens/05-a4-invoices.html) (the section), [`06-invoice-form.html`](../../design/screens/06-invoice-form.html) (the form), [`09-a4-tax-invoice.html`](../../design/screens/09-a4-tax-invoice.html) (the printed invoice), [`04-payment.html`](../../design/screens/04-payment.html) (receiving a payment) |
| **Where it runs** | Same as M3: built and tested in this cloud environment; the Windows app is built by GitHub Actions. |

## Goal (in plain words)

After M4, the office can do all its paperwork for customers:

- **Quotations:** a price offer with lines, discounts and VAT; revisions after it is sent; converted to an invoice in one click.
- **Tax invoices (`INV-`):** simplified or full, chosen by the customer's VAT registration (decision 0010); VAT per line (0009); discounts per line and on the total, spread across the lines (0012). A draft has no number; the number is given at issue (0011). An issued invoice never changes.
- **Three sections in the side menu (decision 0045):** Invoices (A4), Quotations, and Receipts.
- **Receiving payments (the Receipts section):** cash, card, transfer, cheque or a custom method, several methods for one invoice, partial payments. A payment that settles an issued invoice creates no VAT; any part that does not becomes an **advance/progress payment tax invoice** (`INV-`) with its VAT (0013).
- **The final invoice deducts** earlier payments and their VAT, so VAT is counted once (the 100,000 + VAT example in 0013 reproduces exactly).
- **Credit notes (`CN-`)** for returns (goods back to sellable or defective stock, decision 0015) and price corrections, credit notes against advances (work cancelled), **debit notes (`DN-`)**, **refunds (`RFD-`)** and **reversals (`RVS-`)** for a bounced cheque.
- **Customer opening balances** at go-live (by hand or Excel, owner only) and the **statement of account** for any dates.
- **A4 printing:** the server makes a PDF and the app opens the Windows print dialog (0008); reprints are counted and marked "Copy".
- **Every issued document** posts its journal entry in the same transaction (posting map rows 1–11, 20), moves stock for item lines, writes the audit log, and is queued in the e-invoice outbox (0019, nothing is sent yet).

The POS screen, shifts and the cash drawer come in **M5**.

## How the work is delivered

- **Branch:** `m4-sales-pos` (one commit per task, tests after each task).
- **Pull request:** one into `main` at the end, with screenshots (Arabic/light, English/dark). CI green.
- **Decisions:** your answers below become decisions 0045+.

## Tasks

| # | Task | Main files | Tests |
|---|---|---|---|
| T1 | **Migration 0014 — cash core** (tables only, used by the POS in M5): registers, shifts, counts, count lines, and the "only the shift's cashier" function | `db/migrations/0014_cash_core.sql` | Database tests: one open shift per register; only its cashier |
| T2 | **Migration 0015 — sales**: quotations (+ revisions), tax documents and lines, payments, payment and credit allocations, opening balances, held carts. The database enforces: number at issue and gapless; `POS-`/`INV-` never mixed; full invoice ⇔ customer TRN; issued documents immutable; deductions never above what remains or across customers; every receipt fully allocated at commit; credit note quantities never above the original | `db/migrations/0015_sales.sql` | Database tests for every rule, including parallel issue (no gaps, no duplicates) |
| T3 | **Migration 0016 — outbox and print templates**: `ops.outbox`; `sys.print_templates` and their versions (decision 0020), with a default version per document kind; every issued document keeps its template version | `db/migrations/0016_outbox_print.sql` | Versions are append-only; a document reprints with its own version |
| T4 | **Sales engine (server):** line arithmetic through the shared helper (inclusive/exclusive prices, line and document discounts with the largest-remainder spread, VAT per line), discount limits per role and the supervisor approval above them, price override, credit limit; issue = number + stock movements + cost + journal + outbox + audit in one transaction | `apps/server/src/modules/sales/*` | **Property tests** (fast-check): totals always add up, discount spread exact; golden tests for posting rows 1, 2, 6, 7, 8 |
| T5 | **Quotations API:** draft → sent → accepted / rejected / expired; revision; convert to invoice | `apps/server/src/modules/sales/quotations*` | Revisions keep history; converting copies exact amounts |
| T6 | **Payments API:** receive (several methods, partial), automatic allocation to the oldest open invoices or as chosen, the remainder as an advance invoice; refunds; reversal of a bounced cheque (also reverses its advance invoice with a credit note) | `apps/server/src/modules/sales/payments*` | The 0013 example exactly; a payment on an issued invoice adds no VAT; golden tests rows 3, 4, 5, 10, 11 |
| T7 | **Notes API:** credit notes (return to sellable or defective at the cost the goods left with; price correction; against an advance), debit notes; automatic application to an unpaid invoice; refund or keep the credit | `apps/server/src/modules/sales/notes*` | Rows 7, 8, 9; never more than the original |
| T8 | **Opening balances and statement:** customer opening balances (owner only, by hand or Excel, row 20); statement of account for a date range with the running balance | `apps/server/src/modules/sales/statement*`, `imports/*` | Statement balance = Σ documents − Σ payments; receivable control = Σ customer balances |
| T9 | **A4 PDFs:** bilingual templates (tax invoice full/simplified, payment invoice, final invoice with deductions, credit/debit note, quotation, receipt, statement) rendered by pinned headless Chromium on the server; reprint count and "Copy" | `apps/server/src/modules/printing/*`, `apps/server/print-templates/*` | Snapshot tests of the HTML in both languages; the PDF opens; locked tax fields always present |
| T10 | **Screens — Invoices (A4) section (design 05, decision 0045):** the list (invoices, payment invoices, credit and debit notes) with filters and status; the form (design 06): customer search, item search and barcode, lines with discount, totals with VAT, save draft, issue (with the approval dialog when needed); open, print, reprint; credit note from an invoice | `apps/desktop/src/features/invoices/*` | Component tests (amounts exact, both languages) + Playwright |
| T11 | **Screens — Quotations section (own side-menu entry, 0045):** list with status and revisions; form (same line editor as invoices); send, accept, reject, new revision, convert to an invoice; print | `apps/desktop/src/features/quotations/*` | Component tests + Playwright |
| T12 | **Screens — Receipts section (own side-menu entry, 0045; design 04):** list of receipts, refunds and reversals; receive payment (methods, allocation to invoices, the payment invoice that results), print the receipt; refund; reverse a bounced cheque; customer statement and opening balances (from Customers) | `apps/desktop/src/features/receipts/*`, `features/customers/*` | Component tests + Playwright |
| T13 | **CI and docs:** Playwright flows (the 0013 worked example by hand: quotation 100,000 + VAT → receive 31,500 → receive 42,000 → final invoice with 31,500 due), screenshots, decisions, `CLAUDE.md`, PRD, schema, changelog, pull request | `e2e/*`, `docs/*` | Green CI |

## Done when

- All tests pass here and in CI.
- **By hand:**
  - Create a quotation for a pool: 100,000 + VAT.
  - Receive 31,500 → a payment invoice `INV-` with VAT 1,500 is printed.
  - Receive 42,000 → a second payment invoice with VAT 2,000.
  - Issue the final invoice → it shows both deductions and 31,500 due.
  - Return one item from an invoice with a credit note → stock goes back up; the customer's statement shows it.
  - Every document, its journal entry and its stock movement appear in the audit log.

## Questions for the owner

1. **Who issues invoices?** Today's default roles: the owner and the accountant may issue (`invoices.issue`), the cashier/salesperson may prepare drafts (`invoices.create`) and receive payments. **Recommendation:** keep that.
2. **Unpaid invoices for cash customers:** customers start as "cash" (limit 0, decision 0036). If an invoice for a cash customer is issued without full payment, **recommendation:** refuse, unless a supervisor approves (`sales.credit_over_limit`) or the customer has credit. A payment received at issue counts.
3. **Cash received in the office (not at a POS drawer):** which account? **Recommendation:** "Cash in safe" (1120) by default, changeable per payment method (configurable data, waiting for the accountant's review like the rest of the chart).
4. **Cheques:** **recommendation:** a cheque counts as paid on the day it is received (with its date and bank stored); a bounced cheque is reversed (`RVS-`), and the invoice becomes unpaid again.
5. **Quotations:** valid for **15 days** by default (changeable per quotation)? Prices in a quotation are fixed when it is sent; converting uses the quotation's prices, not today's.
6. **Print designer (decision 0020):** **recommendation:** M4 prints with a clean default design that matches design 09, and stores the template version on each document (so later reprints match); the **designer screen** (logo position, colour, language, texts) comes right after as **M4b**, so M4 stays a manageable size.
7. **Customer opening balances:** entered once at go-live, **owner only**, by hand or Excel (same rule as opening stock, decision 0042)?
8. **Payment allocation:** when a customer pays without choosing invoices, **recommendation:** settle the oldest open invoices first, and treat any remainder as an advance (with its payment tax invoice).

## Delivered

| Task | Commit(s) | Result |
|---|---|---|
| Plan, decisions | `b4203ec`, `8fb66cd` | M4 plan; decisions 0045–0052; PRD, `CLAUDE.md` updated |
| T1 | `baafc6f` | Migration 0014: registers, shifts (one cashier per drawer), counts (used by the POS in M5) |
| T2 | `6d85cc9` | Migration 0015: quotations, tax documents, payments, allocations, opening balances; the database enforces numbering at issue, full ⇔ TRN, immutability, deductions, full allocation |
| T3 | `1c7e55f` | Migration 0016: e-invoice outbox (nothing sent yet) and versioned print templates |
| T4–T8 | `0038b41`, `d3efd7b` | Sales contracts, posting rows, the sales API; migration 0017 (quotation prices kept on conversion, notes on payment invoices, credit-limit permission) |
| T9 | `e875660`, `7de169c` | A4 PDFs in Arabic and English (tax invoices, notes, quotations, receipts, statements); reprints marked "Copy" |
| T10–T12 foundation | `ddfb6cb` | Side menu entries, routes, the line editor shared by invoices and quotations, the customer picker |
| T10 | `6867546`, `6748c6e` | Invoices (A4): list, draft, issue with payments and approvals, earlier payments deducted, credit and debit notes, print |
| T11 | `3ae03cb` | Quotations: list, editor, send / accept / reject / revise / convert, print |
| T12 | `4dcbdfb`, `2a7a6b0`, `190e622` | Receipts: receive (oldest first, chosen invoices, advance only), reverse, print; statement and opening balance in Customers; "Receive payment" from an invoice or a customer |
| Fixes | `bd73eb3` | Code review fixes (migration 0018): converted drafts keep agreed prices and discount; one approval per thing (price ≠ discount); notes follow the original line; a fully prepaid invoice is settled; reprints checked on the server |
| T13 | `8424e4b`, this pull request | Playwright flow of the 0013 example (`e2e/sales.spec.ts`), screenshots in [`docs/screenshots/m4`](../screenshots/m4), changelog |

**Not in M4 (follow-ups):**
- Customer opening balances are entered by hand; the Excel import of opening balances is not built yet.
- Refunds are made with a credit note ("pay the money back now"); there is no separate refund screen.
- Notes on individual lines can be set through the API only (the line editor has no note field).
- The print designer screen is M4b (decision 0050).

