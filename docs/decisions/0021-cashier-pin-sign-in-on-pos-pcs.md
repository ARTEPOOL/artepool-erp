# 0021 — Cashier PIN sign-in only on POS PCs

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Decided by** | Owner |

## Decision
- Each user has one **sign-in method**, chosen by the owner when the user is created:
  - **PIN:** a 4-digit PIN. It works **only on PCs enrolled as POS**. These users cannot sign in on office or warehouse PCs at all.
  - **Password:** works on any enrolled PC.
  - **Password + 2-step code:** required for every role marked "requires 2-step", which includes the Owner.
- **Office PCs always need a password.**
- **Weak PINs are refused.** These include:
  - all digits the same (0000, 1111 …)
  - straight sequences (0123, 1234, 9876 …)
  - repeated pairs (1212, 1122)
  - a short list of very common PINs (such as 2580, 1004, 2000, 6969)
- **5 wrong PINs block the PIN.** It stays blocked, with no automatic unblock, until the owner unblocks it in Settings → Users. Supervisor approvals made with a PIN count towards the same limit.

## Why
- Cashiers switch quickly at the counter, and a PIN keeps the queue moving.
- The PIN alone is never enough. The PC itself must be an enrolled POS device (decision 0024), so a PIN is useless anywhere else.
- Blocking until the owner acts makes guessing a 4-digit PIN impossible in practice.

## How it works
- The PIN screen lists only active users whose method is PIN. Blocked or deactivated users cannot sign in.
- **New users and resets:** a new PIN user, or a PIN reset, gets a temporary PIN that is shown once. The user must choose their own PIN at the next sign-in.
- **PINs for other users:** a user with a password can also have a PIN. They use it only for supervisor approvals, never to sign in.
- **What gets logged:**
  - every PIN sign-in, failure and block is written to the audit log
  - the owner's unblock is logged with who did it and when
- **What the server enforces:**
  - PIN sign-in only on an active POS device
  - only for PIN users
  - never for a user who holds a 2-step role

## Consequences
- **Supersedes** the PRD line "Per-user PIN for quick user switching": the PIN is also a sign-in method for cashiers, on POS PCs only.
- **Idle lock on a POS PC** (5 minutes): the PIN user unlocks with the same PIN.
- **A cashier who also needs an office PC** must use the Password method instead.
