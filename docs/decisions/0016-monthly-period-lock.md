# 0016 — Monthly accounting period lock; records never deleted

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner / accountant |

## Decision
- **Accounting periods are monthly.** A month can be **closed** and then **locked**.
- **Records are never deleted.**

## How it works
- **Months are created in advance:** the system keeps them 3 months ahead. If a month is ever missing, the owner gets an alert instead of the system silently accepting postings.
- **Closed or locked months accept nothing:** no postings, no document issues and no stock or cash postings. The database enforces this.
- **Locked is permanent:** a locked month can never be reopened (for example, after the VAT return is filed).
- **Corrections after a lock** are made in the current open month, with a credit note or a reversing entry dated today.
- **Phase 1** includes the lock mechanism and a simple "Periods" admin screen (permission `periods.manage`). Fuller period-close tools come in P2.
