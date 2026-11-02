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

**0.9.0** (plan approved by the owner on 2026-11-02, with the additions below):
- **Split update:**
  - an **app package** in every release (the server program, the screens, the launcher);
  - a **runtime package** (PostgreSQL, Node) only when its version changes;
  - the full installer stays, for new PCs.
- **WebView2** (what draws the app's screens on Windows) is no longer in the small updates. The full installers still install it offline, for PCs that lack it (for example an older Windows 10). If a PC's WebView2 is missing or broken, the PC shows a clear message and the full installer is used instead.
- **Step-by-step install progress** (backup → stop → database update → start), with a clear final result, and the reason when it fails.
- **A status page** while the server is stopped for the update, so every PC can show the steps:
  - steps and the version only: no business data, no device names, user names or company data;
  - read-only;
  - TLS 1.3 with the server's own certificate;
  - every other request refused, and a limit on how often one PC may ask;
  - it closes itself before the new server starts;
  - its start and stop are written in the update's record.
- **The laptop** updates quietly at Windows sign-in, even when the app is not open, and never interrupts someone who is working. On battery it installs normally, unless the battery is below 20%: then it waits for charging or the next check.
- **Waiting for a shift:** System health says "Update ready — will install after the shift is closed". The owner sees an "Install after shift close" note: "Install now" then starts the update by itself as soon as the shift is closed, instead of waiting for the night.

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

## How it works (0.9.0)

**What each release publishes** (`tools/release`):

| File | What it is | When |
|---|---|---|
| `ARTEPOOL-Server-Setup-<v>.exe` | The server PC's full setup, WebView2 offline inside | Every release: new PCs, a USB drive, and the fallback of every update |
| `ARTEPOOL-Server-Update-<v>.exe` | The server PC's programs only: no PostgreSQL, Node or WinSW, and its desktop app without the offline WebView2 | Every release |
| `ARTEPOOL-Office-Setup-<v>.exe` | The office PCs' and the laptop's full app setup, WebView2 offline inside | Every release |
| `ARTEPOOL-Office-Update-<v>.exe` | The same app without the offline WebView2 (it installs WebView2 online only if it is missing) | Every release |
| `ARTEPOOL-Runtime-<id>.zip` | PostgreSQL, Node, WinSW and `runtime.json` | Only in a release whose runtime changed |

- Every file is signed with the update key (`.sig`) and listed in `SHA256SUMS.txt`.
- A runtime package may hold only `node/node.exe`, `pgsql/…`, `winsw/winsw.exe` and `runtime.json`, with plain relative names. Each name is checked before publishing, and again on the PC before unpacking.

**The runtime's id:**
- It is 12 hex characters of a SHA-256 over: the layout version, each pinned program's own SHA-256 (`tools/installer/components.json`), and the parts of PostgreSQL that are left out.
- The same programs always give the same id. A new Node, PostgreSQL or WinSW gives a new one.
- The installed runtime is described by `runtime.json` beside the programs (`C:\Program Files\ARTEPOOL`).
- When a release's runtime is the one already published, its update list points to that earlier release's file, and the runtime is not published again.

**The update list (`latest.json`)** keeps every earlier part and adds the new ones:
- `server`: the full setup. The 0.8.0 updater reads only this.
- `serverUpdate`: the programs, and the runtime id they need.
- `runtime`: id, address, signature, SHA-256, size.
- `office` and `officeUpdate`: the full and the small office setups.
- `platforms`: what the app's built-in updater in 0.8.0 reads. It now points to the small office update, because those PCs already have WebView2.
- Every file has its size, so a PC can show it and add up the progress of two downloads.
- A small-package part that is not right is ignored, and the full setup is used.

**Which package the server PC takes:**
- Its runtime is the one `serverUpdate` names: the update package alone.
- Another runtime: the update package and the runtime package.
- No `runtime.json`, or a runtime package that cannot be downloaded or is refused: the full setup.
- Every file is checked as before: its SHA-256 and signature before it is kept, and again right before it runs.
- A runtime with another PostgreSQL major version is still refused (it needs support), as in 0103.

**Installing the update package:**
- Only the programs are unpacked, beside the installed ones.
- PostgreSQL, Node and WinSW are copied on the same disk from the installed version, or from the checked runtime package. Nothing is downloaded or unpacked twice.
- Then the same steps as 0103: checks and backup, the folder swap, the database changes all or nothing, and the previous version put back on any failure.

**The steps and the status page:**
- The steps are: prepare, stop, backup, database update, start. Each one's start, end and result go into `updates\progress.json`, and into the update's result. System health shows each step and how long it took, and the reason when one fails.
- From the moment the server stops until the new one starts, a status page answers on the server's port:
  - It says only the version and the steps. It never connects to the database: it reads only the steps file.
  - It uses TLS 1.3 with the server's certificate.
  - It answers its two questions (`/health` and the steps) and refuses everything else. It also refuses a PC that asks too often.
  - It runs from a copy outside the program folder, so it never blocks the folder swap.
  - It closes before the new server starts, before the previous version starts again after a failure, and after a time limit.
  - Its start and stop are written in the steps file, so they appear in the update's record.
- While the status page answers, every PC's app shows "Updating ARTEPOOL" with the steps. When the server is back, it shows the result.

**The laptop and the office PCs:**
- A scheduled task "ARTEPOOL App Updater" runs as SYSTEM. The office setup registers it; it is never on the server PC.
- It runs at Windows sign-in, every hour, and when the app asks.
- It downloads the small office update in the background (it continues after a cut) into `C:\ProgramData\ARTEPOOL`, in a folder only SYSTEM and administrators can write. It checks the signature before keeping the file and again before running it.
- It installs quietly, without Windows' permission question, and only when the app is closed. Someone signed in is never interrupted: the app's notice "Install and restart" stays. Pressing it closes the app, installs the update and opens the app again.
- On battery it installs normally, unless the battery is below 20%. Then it waits for charging or the next check.
- PCs on 0.8.0 take 0.9.0 the old way, once (the app's own updater, the small office update).
