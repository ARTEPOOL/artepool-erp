# 0094 — Adding the cashier and the owner's laptop

| | |
|---|---|
| **Status** | Accepted (2026-10-19) |
| **Date** | 2026-10-19 |
| **Decided by** | Owner |
| **Related** | [0021](0021-cashier-pin-sign-in-on-pos-pcs.md), [0024](0024-device-enrollment-proves-the-server.md), [0026](0026-users-and-devices-never-deleted.md), [0082](0082-app-mode-by-device-kind-and-pos-kiosk.md), [0087](0087-cashiers-and-drawers-growth.md), [0089](0089-kiosk-lock-switch-per-pos-device.md), [0090](0090-pos-idle-behaviour.md), [0093](0093-no-remote-access-in-phase-1.md) |

## Decision
- **The cashier:** the owner adds the cashier in Settings → Users (name, role Cashier, 4-digit PIN). From then on the POS PC opens straight to the PIN screen in kiosk mode (0082, 0083, 0089; no automatic lock, a voluntary "Lock screen" button, the owner's auto-lock setting off by default, 0090).
- **No separate executable or icon:** the PC's enrolled kind decides the mode, so a cashier can never open the full office mode from a shortcut.
- **Growth without redesign (0087):** two cashiers on the same POS PC, each with their own PIN and their own shift (the open shift must be closed before another cashier opens one, 0004), and a second POS PC with its own drawer.
- **The owner's laptop:** install the Office installer → on the POS/server PC, Settings → Devices → new enrollment code → type it on the laptop → sign in with the same owner account (password + 2-step). It works on the shop LAN only (0093). Revoking it in Settings → Devices blocks it at once (0026).

## Why
Every step is done from the screens by the owner, and the cashier's PC can only ever be a cashier's PC.

## How it works
Already built in M1–M5c (users and PINs, enrollment codes, device kinds, kiosk mode, revoke); part 3 and part 5 of M6 check them end to end on the installed system and fill any gap.
