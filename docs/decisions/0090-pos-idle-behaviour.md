# 0090 — POS idle behaviour: the cashier's session stays open; a "Lock screen" button

| | |
|---|---|
| **Status** | Accepted (2026-10-19) |
| **Date** | 2026-10-19 |
| **Decided by** | Owner |
| **Related** | [0079](0079-screen-lock-optional.md), [0089](0089-kiosk-lock-switch-per-pos-device.md), [0074](0074-approvals-with-the-phone-code.md) |

## Decision
- **No automatic return to the PIN screen on POS PCs.** The cashier's session stays open in the POS app for as long as needed; only leaving the app needs the owner (kiosk rules, 0089).
- **A "Lock screen" button on the POS screen:** the cashier locks it when stepping away. The **same cashier** resumes with their PIN; the shift stays open; nobody else can use that session.
- **Owner-only setting "Auto-lock after N minutes of no input"** for POS PCs, **disabled by default**, audited when changed, kept for later (for example with two cashiers). It is the POS line of the screen-lock setting (0079, Settings → Devices).
- **Supervisor approvals stay unchanged** (0074): sensitive actions still need the approver's one-time code.

## Why
One cashier works the counter all day; a lock that keeps coming back slows the queue. The cashier can still lock on purpose, and the owner can turn auto-lock on later.

## Consequences
- With auto-lock off, a cashier who walks away without locking leaves their session open; the "Lock screen" button and the session's maximum length (0079) are the guards.
