# 0081 — The owner dashboard: what it shows and how each number is counted

| | |
|---|---|
| **Status** | Accepted (VAT and profit figures pending the accountant's review) |
| **Date** | 2026-10-18 |
| **Decided by** | Owner |
| **Builds** | [0039](0039-owner-reports-dashboard.md) |

## Decision
- **Reports** in the side menu opens the owner dashboard. Owner only (`reports.owner_dashboard`, owner-only); the server refuses anyone else.
- **Period:** Today (default), This week (from Monday), This month, This year, or From–To. Each figure shows its change against the same number of days just before.
- **The four figures**, counted on each document's issue date (Al Ain) from issued documents, credit notes counted negative:
  1. Total sales with VAT;
  2. Sales without VAT;
  3. VAT due: VAT on sales after returns. There are no purchases in the program yet, so no input VAT is taken off; it will be once purchases are recorded;
  4. Gross profit: sales without VAT minus the cost stored on each sale line when it was issued ([0038](0038-item-purchase-price-owner-only.md)), with the margin %.
  Advance-payment invoices count when issued; the final invoice deducts them, so a project is counted once.
- **Extras the owner chose:** the day-by-day chart; sales split by POS / A4, money received per payment method and what is still unpaid from the period; sales per employee; the top 10 items (quantity, net, profit) and top 10 customers (the cash customer left out).
- **Right now:** open shifts with their expected cash and the total in drawers; the safe (the balance of its ledger account); the period's over/short; what customers owe and how much is overdue, with the biggest debtors; the stock value at cost and the items at or under their reorder level.

## Why
The owner wants one screen with what was sold, what is owed in VAT, what was earned, and where the money and stock stand.

## How it works
- Migration 0033 adds the owner-only permission and an index on issued documents by day. No new table: everything is read from documents, payments, shifts, the ledger and stock.
- `GET /api/v1/reports/owner-dashboard?period=…&from=…&to=…`.

## Still open
The "Net profit after expenses" report needs the expenses screen (PRD 9.8) and comes after it. The accountant reviews the VAT and profit definitions with the chart of accounts.
