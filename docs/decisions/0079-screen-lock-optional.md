# 0079 — The idle screen lock can be turned off

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-18 |
| **Decided by** | Owner |

## Decision
- **Settings → Devices → Screen lock** has one switch for office PCs and one for POS PCs. When a switch is on, the owner types the minutes without use (1–240) before the screen locks.
- When a switch is off, that kind of PC never locks for being idle. The session still ends after `security.session_max_hours` (12 hours by default), and then the person signs in again.
- At the owner's request, both switches are **off** from now on (they were 15 minutes for office PCs and 5 for POS PCs).
- Only the owner changes it (`system.settings.edit`); every change is in the audit log. New sign-ins use the new values.

## Risk the owner accepted
Without a lock, anyone who finds a PC left open works under that person's name: the owner's account, or a cashier's drawer. Sign out or lock the screen by hand when you leave a PC.

## How it works
Migration 0032: `security.idle_lock_minutes.office` and `.pos` may be 0 (off) and are set to 0. With 0, a session's idle limit is the session's whole length. `GET`/`PUT /api/v1/settings/screen-lock`.
