# 0089 — A "Kiosk lock" switch per POS PC, owner only, kept on the server

| | |
|---|---|
| **Status** | Proposed — waiting for the owner's approval |
| **Date** | 2026-10-18 |
| **Decided by** | Owner (requirements); details proposed |
| **Related** | [0082](0082-app-mode-by-device-kind-and-pos-kiosk.md), [0083](0083-exiting-kiosk-mode-owner-only.md) |

## Decision
- **Settings → Devices:** every POS PC has a **Kiosk lock** switch. **Default ON** for every POS PC (new and existing).
- **Only the owner changes it**, with a **2-step step-up** (the current 6-digit code, even on a trusted PC) and a **reason**. Every change is audited (who, which PC, on/off, until when, reason).
- **Turn off for…:** 15 minutes, 1 hour, or until I turn it back on. A timed "off" returns to ON by itself when its time is up (decided by the server clock).
- **What OFF means — only the screen lock is lifted:**
  - the app may be minimised or closed, and the watchdog does not restart it;
  - it still starts by itself at Windows sign-in;
  - PIN sign-in, shifts, drawer ownership and every permission stay exactly the same.
- **While OFF:** the POS screen shows a clear **"Kiosk lock is off"** banner (with "until …" when timed), and the owner gets an alert when it is turned off and again when it comes back on.
- **Stored on the server, never on the POS PC:** the switch is a row on the server, so the cashier cannot change it locally. The POS app reads it at start and checks it every few seconds; if the server cannot be reached, the app stays **locked**.

## How it fits with 0083
- "Unlock POS" from the owner's Office PC (0083) **is** this switch turned off for 15 minutes; the two are one mechanism.
- The fallback **Unlock with owner code** on the lock screen (0083) also turns the switch off for 15 minutes, with the same audit and alert; it cannot choose a longer time.

## How it works (to build, M5c)
- A per-device setting on the server: `kiosk_lock` (on/off), `off_until` (empty = until turned on), changed only through an owner-only API that checks a fresh 2-step code; history kept (never deleted) and audited.
- New alert types: `kiosk_lock_off`, `kiosk_lock_on`.
