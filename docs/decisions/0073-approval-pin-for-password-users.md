# 0073 — An approval PIN for supervisors who sign in with a password

| | |
|---|---|
| **Status** | Replaced by [0074](0074-approvals-with-the-phone-code.md) |
| **Date** | 2026-10-17 |
| **Decided by** | Owner |
| **Refines** | [0021](0021-cashier-pin-sign-in-on-pos-pcs.md) |

## Problem
A supervisor's approval (a discount above the limit, a return, cancelling an invoice) is given by choosing the approver and typing their PIN. The owner, the accountant and other office users sign in with a password, and had no way to choose a PIN. So they never appeared in the approval list.

## Decision
- **Account menu → Approval PIN:** any user who signs in with a password chooses their own 4-digit approval PIN.
  - Their current password confirms it.
  - Weak PINs are refused (the same rules as cashier PINs).
  - Every change is audited.
- The approval PIN **only approves**. It never signs anyone in: PIN sign-in stays for PIN users on POS PCs only (0021).
- Five wrong approval PINs block it until the owner unblocks it, as for cashiers.

## Consequences
- To approve, the approver must have set an approval PIN; the list shows only those who have.
