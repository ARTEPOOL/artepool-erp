# 0074 — Supervisor approvals with the one-time code from the approver's phone

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-17 |
| **Decided by** | Owner |
| **Replaces** | [0073](0073-approval-pin-for-password-users.md) |

## Decision
- Every supervisor approval is given with the **6-digit code shown at that moment in the approver's 2-step app**. That covers discounts above the limit, price changes, oversell, returns, recounts, unpaid invoices, cancelling or editing an invoice, and every other approval.
  - The code changes every 30 seconds.
  - It is accepted **once**: a code seen over a shoulder is useless.
- **Only people with 2-step turned on can approve.** In Settings → Users, set a supervisor's sign-in to "password + verification code"; they set up the app at their next sign-in. The owner already has it.
- **Approval PINs are gone** (0073 is replaced). Cashier PINs for signing in at the POS are unchanged (0021).
- **Wrong codes** count separately from PINs and passwords:
  - after 5 wrong codes, the person's **approvals** are blocked until the owner unblocks them in Settings → Users;
  - their sign-in is not affected.
- Every approval is audited: who asked, who approved, the reason, and what it was used for.

## Why
- A fixed PIN typed on someone else's PC can be watched and reused; a one-time code cannot.
- The owner asked for it.

## Consequences
- Migration 0028 adds the approval-code failure count and block.
- A supervisor without a phone app cannot approve.
