# 0027 — "Trust this PC" for the 2-step code (30 days)

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Decided by** | Owner |

## Decision
- **The choice:** the screen that asks for the 6-digit code has a box: **"Trust this PC for 30 days"**. It is off by default.
  - It is offered to everyone who uses the 2-step code (the owner, and anyone set to "Password + 2-step code").
  - It is offered on every enrolled PC **except POS PCs**.
- **What it does:** for 30 days, that person signs in **on that PC** with the password alone.
  - The phone code is still needed on every other PC.
  - The password, the lockout after wrong passwords and the idle lock all stay as they are.
- **How long:** 30 days from the moment the box was ticked. Signing in does not extend it. Ticking the box again later starts a new 30 days.
- **It ends by itself when:**
  - the person's password changes, whether they changed it, the owner reset it, or it was recovered (decision 0028);
  - the 2-step code is set up again or reset;
  - the person is deactivated;
  - the PC is revoked, or its type becomes POS.
- **Ending it by hand:** the owner can end it at any time in **Settings → Devices**, with the **End trust** button.
- **Setting:** `security.trusted_device_days`, default **30**, from 0 to 90. **0 turns the feature off** and ignores every existing trust. Lowering the number also shortens trusts that already exist.

## Why
- The owner signs in every day on their own PC. Typing the phone code every time is the slowest part, and it adds little there.
- The phone code keeps its full protection where it matters most: on any other PC. A stolen password is useless on a PC the owner never trusted, and a PC that is not enrolled cannot reach the server at all.

## How it works
- **Storage:** each trust is a row in `auth.device_trust` (person, PC, start, expiry, end and reason). Rows are never deleted.
- **Database rules:** the database itself enforces the rules, so no mistake in the program can skip them.
  - A trust can only be created by the person signing in, on that same PC, with an active 2-step code.
  - It is refused on POS PCs and revoked PCs.
  - A password-only sign-in of a 2-step user is accepted only on a PC with an open, unexpired trust, and only while the setting allows it.
  - The automatic endings listed above are triggers on the users and devices tables.
- **Audit log:** trusting a PC, each sign-in that used the trust (sign-in method "trusted PC"), and each ending, with its reason.

## Consequences
- On a trusted PC, the password alone opens the account. Do not tick the box on a PC that other people use with your Windows account. Lock the screen when you walk away.
- If a trusted PC is lost or stolen, revoke it in **Settings → Devices**. That also ends its trust.
