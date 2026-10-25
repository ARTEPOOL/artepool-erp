# 0039 — Owner reports dashboard: four numbers, a date range, and a net-profit report

| | |
|---|---|
| **Status** | Accepted; the dashboard is built in [0081](0081-owner-dashboard.md), net profit after expenses waits for the expenses screen |
| **Date** | 2026-10-11 |
| **Decided by** | Owner |

## Decision
- **The reports dashboard is for the owner only.** Cost and profit are never shown to anyone else.
- **Four main figures:**
  1. **Total sales** (including VAT), after returns.
  2. **VAT due:** VAT on sales minus VAT on purchases (recoverable).
  3. **Sales without VAT.**
  4. **Profit:** sales without VAT minus the cost of the goods sold.
- **A detailed report: net profit** after expenses such as rent and bills.
- **Date range:** Today (default), This week, This month, This year, or From–To dates.
- **Expenses screen:** a simple "New expense" (type, amount, date, note) that posts to the ledger. Approved by the owner.

## Why
- The owner wants to open one screen and see what was sold, what is owed in VAT, and what was earned.

## How it works
- **Cost of goods sold** comes from the cost copied onto each sale line when it is issued ([0038](0038-item-purchase-price-owner-only.md)).
- **Expenses are posted in the ledger,** so they need the journal tables (migration `gl_journals`, M3). The plan already has an expenses module in Phase 2 ([PRD 9.8](../../PRD.md)). They are built when the ledger exists, not before: an expense kept outside the ledger would break "one transaction posts everything" (golden rule 4).
- **Order of work:** purchase price on items (done, M2) → stock and journals (M3) → sales and POS, which store the cost on every sale (M4) → cash (M5) → expenses, the four figures and the detailed report (P2 reports).

## Consequences
- Until sales exist, the dashboard has nothing to show; the data it needs (purchase price on items) is collected from now.
- The accountant gets the VAT and sales reports through the reports module, not the owner's profit dashboard.
