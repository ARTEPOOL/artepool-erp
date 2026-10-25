# 0091 — Kiosk lock off while the owner is signed in on the POS PC; owner code 15 minutes

| | |
|---|---|
| **Status** | Accepted (2026-10-19) |
| **Date** | 2026-10-19 |
| **Decided by** | Owner |
| **Related** | [0082](0082-app-mode-by-device-kind-and-pos-kiosk.md), [0083](0083-exiting-kiosk-mode-owner-only.md), [0089](0089-kiosk-lock-switch-per-pos-device.md), [0078](0078-owner-remembered-on-pos-pcs.md) |

## Decision
- **The owner signed in on a POS PC lifts that PC's kiosk lock by itself.** No switch, no code: while the owner's session on that PC is open (not locked, not expired), the app can be minimised or closed there.
- **It comes back when the owner signs out or locks the screen** (or when the session ends: its maximum length, a password change, a revoke). There is no extra idle limit for this (owner's choice); the screen-lock setting (0079) still applies if the owner turns it on.
- **The password alone is enough** where that PC already remembers the owner (0078); otherwise the owner signs in as usual with the phone code.
- **The owner code on the lock screen now lifts the lock for 15 minutes** (was 5 in 0083/0089). It stays for emergencies when the owner is away; a longer time is set from Settings on another PC.
- **Banner** while the owner is signed in: "القفل متوقف · طول ما المالك داخل" / "Kiosk lock is off · while the owner is signed in". Settings → Devices shows "القفل متوقف · المالك داخل على الجهاز".
- The owner's sign-in and sign-out on that PC are already in the audit log; no extra alert is raised (the owner is the one at the PC).

## Why
The owner works on the counter PC himself at times (maintenance, printers) and should not need a switch or a code for it; when he leaves and signs out, the counter is locked again. The 5-minute owner code was too short for a real repair over the phone.

## How it works (migration 0035)
- `auth.owner_signed_in_on(device)`: an open, full, unlocked, unexpired owner session on that PC (same tests as the API applies on every request).
- `auth.kiosk_state` adds `owner_signed_in`; `locked` is false while it is true. The POS app (and the Windows layer, every 5 seconds) reads it as before; the screens ask again right after a sign-in, lock or sign-out.
- The database allows an owner-code "off" of at most 15 minutes.
