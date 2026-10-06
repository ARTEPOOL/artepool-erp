# 0018 — Chart of accounts and posting map

| | |
|---|---|
| **Status** | **Pending accountant review** (must be approved before go-live) |
| **Date** | 2026-10-06 |
| **Decided by** | Owner (structure); accountant review pending |

## Decision
- **Seed a provisional chart of accounts.**
- **Revenue is split by line of business:** pool supplies, construction, maintenance and cleaning.
- **The chart includes at least:**
  - cash, bank
  - inventory, inventory – defective
  - accounts receivable, accounts payable
  - customer advances (liability)
  - VAT payable, VAT recoverable
  - owners' equity
  - cost of goods sold
  - common operating expenses
- **A one-page plain-language posting map** shows which operation posts to which account.

## Where
- `docs/accounting/chart-of-accounts.md`: the provisional chart.
- `docs/accounting/posting-map.md`: the one-page posting map for the accountant.

## Rules while pending
- **Everything stays configurable.** Accounts, the account for each line of business, and the "which account for which event" mappings are **data**, never hard-coded. The accountant's changes are applied without code changes.
- **Development can proceed** on the provisional chart. **Go-live is blocked** until the accountant approves the chart and the posting map.
- **After go-live,** changes are made by adding accounts or changing mappings. Posted entries are never rewritten.
