# 0110 — "Check now" for updates, and a failed upgrade that says why

| | |
|---|---|
| **Status** | Accepted (2026-10-28) |
| **Date** | 2026-10-28 |
| **Decided by** | Owner |
| **Related** | Extends [0108](0108-automatic-online-updates.md) automatic online updates; [0103](0103-upgrades-and-uninstall-never-touch-data.md) upgrades never touch the data |

## Decision

- **"Check now"**: System health → Updates has a **Check now** button for the owner. The server PC reads the update list on its next run of the updater, within 5 minutes, and the card says "Checking for updates…" until it has. The server PC **still checks by itself every few hours** and installs at night as in 0108 (the owner chose "button + automatic").
- **The version just installed is never "new"**: right after an update the server PC forgets what it kept for that version (no "new version", no "installing", no setup file) and reads the update list again at once. The screen shows a version as new only when it is newer than the one running.
- **A failed upgrade says why where people look first**: the server setup copies the reason into its own log and its message, not only into the upgrade program's log.
- **CI test versions are marked and named**: the two test upgrades the Windows CI builds are named `…-TEST.exe`, say TEST on every page and warn first that they are never for the shop. A PC that once ran one cannot take any real version (its test migration is in none); the upgrade then refuses with "nothing was changed" and says in plain words to delete the data and install again.

## Why

- The owner wants to check for updates when they choose, not only when the program does.
- On 2026-10-28 the server PC showed "New version 0.3.0 · installing now…" and an "Install now" button although 0.3.0 was already running: the old state stayed until the next 6-hourly check.
- On the same day an upgrade from a CI test version (0.1.1) to 0.2.0 was refused and rolled back safely, but the setup's message and log only said "exit code 1"; the reason was in a second log file.

## How it works

- Migration 0046 adds `ops.update_state.check_requested_at`. Only the owner sets it (a guard in the database; `system.update.manage` in the API); every change is in the audit log. The updater reads the list when that time is newer than its last check.
- `POST /api/v1/system/update/check`; the status says `checking` until the updater has read the list.
- The upgrade program checks, before stopping anything, that the database's applied migrations are the new version's first files. It writes `updates\last-failure.txt` (step, reason) on any failure; the setup copies it into its log ("Reason (step): …") and its message.

## Consequences

- "Check now" never installs anything by itself: installing still follows 0108 (safe time, checked backup, night window or "Install now").
- Release notes are written in the same plain Egyptian Arabic as the screens from 0.4.0 on, and shown one point per line.
