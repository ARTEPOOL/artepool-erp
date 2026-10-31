# 0115 — Fast updates: an instant check, an instant start, a progress bar, smaller downloads

| | |
|---|---|
| **Status** | Accepted (2026-10-31) |
| **Date** | 2026-10-31 |
| **Decided by** | Owner |
| **Related** | Extends [0108](0108-automatic-online-updates.md) automatic online updates and [0110](0110-check-for-updates-now.md) "Check now"; [0103](0103-upgrades-and-uninstall-never-touch-data.md) upgrades never touch the data |

## Decision

Two releases.

**0.8.0:**
- **"Check now" answers in seconds.** The server reads the update list itself the moment the owner presses it, and the card shows the result at once.
- **"Install now" starts at once.** The server wakes the updater straight away instead of letting it wait for its next run. The updater still runs every minute by itself, but only as a fallback.
- **A progress bar** shows the download from 0 to 100%, with the megabytes received of the total and the time left, refreshed every second.
- **Downloads continue where they stopped** after a cut in the internet, instead of starting again.
- **Downloaded in advance:** when a newer version is found, it is downloaded and verified in the background straight away, so "Install now" starts from a file that is ready and checked.
- **Automatic check every hour** (it was every 6 hours).
- **Installing keeps the safe-time rules of 0108**: never while a shift is open, after a checked backup, at night or by "Install now".

**0.9.0:**
- **Split update:**
  - an **app package** in every release (the server program, the screens, the launcher);
  - a **runtime package** (PostgreSQL, Node) only when its version changes;
  - the full installer stays, for new PCs.
- **Step-by-step install progress** (backup → stop → database update → start), with a clear final result, and the reason when it fails.
- **The laptop** updates quietly at Windows sign-in, even when the app is not open, and never interrupts someone who is working.

Unchanged: the update key's signature and the SHA-256 check before a file is kept and again before it runs; the checked backup before every update; putting the old version back on any failure.

## Why

The owner's test on 2026-10-31:
- "Check now" took minutes. The updater, a scheduled task, ran only every 5 minutes.
- The download was slow and showed nothing. Every update carries the whole server setup, 288 MB (PostgreSQL, Node and the programs), and the program part is the only one that changes.
- "Install now" also waited for the next run. Then the setup unpacked about 500 MB.

## How it works (0.8.0)

**Waking the updater:**
- The updater stays the scheduled task "ARTEPOOL Updater": SYSTEM, one run at a time, and now every minute.
- The task's security descriptor lets the server's own account (`NT SERVICE\ArtepoolServer`, by its service SID) start it, and nothing else.
- After the commit of "Check now" and "Install now", the server runs `schtasks /Run` on it.
- The waking carries nothing. The updater decides everything from the database and the signed update list, as before. A failed wake only means the next minute's run.

**"Check now":**
- The server reads the update list before its database transaction, so a slow internet never holds the transaction open.
- In one transaction it then records the owner's request and the result: the version, the notes and when.
- The database lets the server's role write these columns only for the owner (migration 0050). The updater still fetches the list itself before it downloads anything.

**Progress:**
- The updater writes the bytes received, the total and the speed at most once a second, in `ops.update_state` columns that the audit log ignores. The audit's existing ignored-columns rule is used, so a download does not add hundreds of entries.
- Its status changes (downloading → ready, failed) stay in the audit log as before.

**Continuing a download:**
- The part already received stays in `updates\` beside a note of its address and SHA-256.
- The next run asks only for the rest (an HTTP range). It starts again if the server sends the whole file, or the note doesn't match.
- A file whose SHA-256 or signature is wrong is deleted, as before.
