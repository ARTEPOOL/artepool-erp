# 0015 — Defective returns held at cost until written off

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner / accountant |

## Decision
Returned broken goods are **held at cost in "Inventory – defective"** until they are written off.

## How it works
- **The return:** a credit note line marked "return to defective" puts the goods into the **defective** stock bucket of the warehouse, separate from sellable stock. They come back at the **cost they left at**.
- **Accounts:** the value moves into the **Inventory – defective** account. Cost of sales is reversed for the returned goods.
- **Write-off:** when the goods are written off (permission `stock.write_off`, mandatory reason, approval above the threshold), the value moves to the **Defective stock write-offs** expense.
- **P2:** returning defective goods to a supplier becomes possible.
