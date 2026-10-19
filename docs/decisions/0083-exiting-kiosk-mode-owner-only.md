# 0083 — Leaving kiosk mode: the owner only, for a limited time

| | |
|---|---|
| **Status** | Accepted (2026-10-19) |
| **Date** | 2026-10-18 |
| **Decided by** | Owner |

> The Office-PC unlock and the owner-code unlock are the per-PC "Kiosk lock" switch of [0089](0089-kiosk-lock-switch-per-pos-device.md) turned off: from the Office PC for 15 minutes, 1 hour or until turned back on; with the owner code for at most 5 minutes.

## Decision
- **Only the owner** unlocks a POS PC out of kiosk mode, for the time chosen (0089), then kiosk mode returns by itself (the app goes back to full screen and the watchdog is armed again). The owner can also end it early.
- **Primary: from the owner's Office PC.** Settings → Devices → that POS PC → **Unlock POS**. The owner's session must have the 2-step code (a trusted-PC sign-in is not enough: the owner types the current 6-digit code to confirm). The POS PC sees the unlock within seconds.
- **Fallback when the owner is away or offline:** on the kiosk lock screen, **Unlock with owner code**: someone types the owner's current 6-digit code read from the owner's phone. It lifts the lock for **at most 5 minutes**.
  - accepted once (the same step can never be used again, shared with sign-in and approvals, 0074);
  - valid only for that PC, at that moment;
  - 5 wrong codes in 15 minutes lock the fallback for 15 minutes and raise an alert;
  - the code is checked by the server; since the server runs on the POS PC (0085), it works without internet.
- **Audit and alerts:** every unlock request, success, failure, expiry and early end is in the audit log (who, which PC, how: Office PC or code) and raises an owner alert.
- **Last resort** if the app or the API service cannot start: the owner signs in to the Windows administrator account (Ctrl+Alt+Del → Switch user). Its password is known only to the owner.

## Why
The owner may need the PC for maintenance or a printer driver, sometimes while away; nobody else may leave the POS.

## How it works (to build)
- A table of unlocks (PC, owner, how, from, until, ended_at, end_reason), never deleted, audited; the API grants and ends them, the POS app polls its own state.
- New alert types: `kiosk_exit_attempt`, `kiosk_unlocked`, `kiosk_code_blocked`.
