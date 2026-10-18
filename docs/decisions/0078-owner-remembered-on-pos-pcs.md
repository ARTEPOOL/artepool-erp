# 0078 — The owner may be remembered on POS PCs too

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-18 |
| **Decided by** | Owner |
| **Changes** | [0027](0027-trust-this-pc-for-the-2-step-code.md), [0077](0077-two-step-code-once-per-pc.md) (POS PCs) |

## Decision
- The owner, and **only the owner**, sees "Remember this PC" on POS PCs too. After the phone code there once, the owner signs in on that POS PC with the password alone until the password changes.
- Everyone else (accountant, supervisors…) still types the phone code on POS PCs every time; on office PCs, 0077 applies to them as before.
- Turning a PC into a POS PC ends everyone's trust on it except the owner's. Revoking a PC ends every trust, the owner's too.

## Why
The owner signs in on the counter PC (it holds a cash drawer) many times a day.

## Risk the owner accepted
On a POS PC that remembers the owner, anyone who learns the owner's password can open the owner's account there without the phone. Keep the password private, and lock the screen when leaving the counter. The owner can end the trust in **Settings → Devices** at any time.

## How it works
Migration 0031: `auth.is_owner()`; the database rules for creating a trust, signing in on a trusted PC and ending trusts when a PC becomes POS now make the owner the one exception. The server offers the box on POS PCs only to the owner.
