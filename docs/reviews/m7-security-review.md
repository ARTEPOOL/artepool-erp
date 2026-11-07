# M7 security review (Part F)

| | |
|---|---|
| **Date** | 2026-11-07 |
| **Branch** | `m7-acceptance-tools` (version 0.10.0) |
| **Scope** | The whole Phase 1 system: the API and its 248 routes, the database privileges, TLS and enrollment, the secrets and the launcher, updates (server PC and office PCs), logs, backups and restore, the emergency tool, the kiosk lock, the cashier's Windows account, the rehearsal, delete-data and the update status page |
| **Method** | Three independent read-only reviews of the code (permissions and database privileges; TLS, secrets, updates, logs and backups; emergency tool, kiosk, cashier account and rehearsal). Each finding was checked in the code, then fixed with a test or listed below with a plan. The weekly dependency check was run too. |
| **Result** | **Nothing critical or high.** 3 medium findings (one partly fixed, two listed with a plan for before go-live), 11 low findings (9 fixed), and some information items. |

## In plain words (for the owner)

- Nobody on the network can read or change the shop's data without an enrolled PC, a signed-in user and the right permission. The reviews found no way round that.
- The findings are about **someone who is already on a PC in the shop** (for example, the cashier's Windows account on the server PC) or **a fault inside one of our programs**: they make the damage such a person or fault could do smaller.
- Fixed now: amounts hidden from people who should not see them, the blind count kept blind for the accountant too, exports, one reconciliation report at a time, secrets not passed on to other programs, update files tied to their name and version, and the emergency actions now say which Windows account ran them.
- **Three items need a decision from you before go-live** (end of this page). They change how Windows protects files on the server PC and the laptop, so they need a full test round on Windows.

## Findings and their status

### Medium

| # | Finding | Status |
|---|---|---|
| M1 | **Secrets shared too widely.** Every program got every database role's password, including the network-facing API service; the server and backup service accounts can read the whole `secrets` folder (machine-scope DPAPI with public extra entropy), and `secrets\tls\ca.key` is a plain PEM file in it. Code running inside the API could reach the migrator and superuser passwords and the CA key. | **Partly fixed.** The launcher now gives each service only its own role's password: the server (API) the api role's, the backup service and the updater the backup role's (test: every program the launcher may start is a service or a whole-system program). The updater's and the upgrade's child programs (the setup, `tar`, the cashier-account check, the rehearsal, the status page) start with no secret at all. **Open:** a file permission per secret and `ca.key` closed to SYSTEM and Administrators (see "Decisions for the owner", item 1). |
| M2 | **The server PC's shared enrollment can be replaced by any Windows account on it.** `ProgramData\ARTEPOOL\device` is writable by every user (decision 0088, so the owner's and the cashier's accounts share the PC's enrollment); the file is sealed with the machine key and a fixed extra key. The cashier's account could point the app to a relay with its own CA and capture the owner's password and live phone code when the owner signs in on that PC, or change the PC's kind to "office" to start without the kiosk lock. | **Open, before go-live** (item 2). Needs physical use of the server PC's cashier account and preparation; nothing on the network. |
| M3 | **The laptop's quiet-updater folder can be created first by a standard user.** `ProgramData\ARTEPOOL\app-updates` is given its permissions only when it is new, and the updater runs a copy of itself from there as SYSTEM. A user who created the folder first could plant files next to it and get SYSTEM on that laptop. | **Open, before the laptop is enrolled** (item 3). Not on the server PC (no quiet updater there). |

### Low

| # | Finding | Status |
|---|---|---|
| L1 | Customer amounts without `customers.balance.view`: the credit limit in a customer's details and the opening balance went to everyone with `customers.view` (the cashier and the technician), against decision 0114. | **Fixed.** The credit limit (details, saves, the customers export) only with `customers.balance.view`; the opening balance only for `payments.receive`. The customer page and the credit window work without the amount. Tests on the server and the screen. |
| L2 | The API could write any kind of row into `ops.integrity_runs`, and System health showed the newest row of any kind: an accountant's reconciliation report replaced the nightly checks on the integrity line. | **Fixed.** Migration 0056: the API records reconciliation reports only (database trigger); the System health line shows the checks of the books only. Tests. |
| L3 | The X report showed the expected cash before the count to anyone with `shifts.view_all` on their **own** open shift (the accountant), against 0006 and 0080. | **Fixed.** On one's own open shift only the owner sees it; a supervisor still sees it on someone else's shift. Tests. |
| L4 | One `data.export` permission exported customers, suppliers and items without the matching read permission. | **Fixed.** Each export also needs `customers.view`, `suppliers.manage` or `items.view`; the customers export leaves the credit limit empty without `customers.balance.view`. Tests. |
| L5 | Reconciliation reports had no limit on parallel runs: about 20 at once could use every database connection and slow the tills. | **Fixed.** One at a time on the server; a second request is answered «فيه تقرير مطابقة بيتعمل دلوقتي». Test. |
| L6 | The updater's and the upgrade's child programs inherited the master key and the role passwords (the status page during an upgrade even had the superuser's). | **Fixed** (`childEnv({})` everywhere). |
| L7 | Gaps in log redaction (the setup-token header, recovery codes, the backup key, nested password/PIN/token fields). Nothing leaked: no request body or header is ever logged. | **Fixed.** Added. An error's `code` stays visible on purpose: it is what the logs are read for, and request bodies are never logged. |
| L8 | Emergency-tool and console resets were recorded as SYSTEM with a reason only. | **Fixed.** The owner password and 2-step resets, the first owner and the console enrollment codes keep the Windows account and the PC's name. Tests. |
| L9 | An update's signature was not tied to the file's name, and the laptop's quiet updater did not tie the download to the listed version: whoever could publish the update list (without the signing key) could push an **older** signed office setup. (The server PC's setup already refused an older version.) | **Fixed.** Both updaters require the signature's `file:` to be the expected name; the laptop's updater keeps only downloads whose folder and name are the listed version. Tests (TypeScript and Rust). |
| L10 | The cashier can leave the kiosk without an alert by editing the watchdog's state file in their own profile, then ending the app. | **Open.** Recommended: an alert on System health when a locked POS PC stops checking in (no local file is trusted). Small; can follow go-live. |
| L11 | The lock screen's owner code can be guessed slowly: 5 tries per 15 minutes, then it opens again by itself (about a 40% chance in a year; the most it gives is 15 minutes unlocked, capped by the database). | **Open, owner's choice** (item 4). |

### Information (no change needed now)

- The backup key pair is made on the server and shown once; a copy on Google Drive proves it is intact, not who made it. Generating the key on the owner's PC and keeping a list of each copy's SHA-256 outside Drive would close this. Recorded for the backup work after go-live.
- The database's checks of "who is acting" trust the context the API sets: they stop mistakes in our code, not someone holding the API's password (which M1 now keeps away from the other programs).
- `enroll/hello` can be used to guess an open enrollment code offline; the code's strength (about 44.6 bits, Argon2id, 10 minutes, cancelled after 5 wrong tries) is enough. Do not shorten the code.
- The launcher accepts any `NT SERVICE\*` account on the secrets folder; it could name ARTÉPOOL's three services exactly (with item 1).
- The external-drive copies are not encrypted: the owner's choice (decision 0086).
- The rehearsal uses the PostgreSQL superuser to create and drop its own database (limited by the name, a mark and a token). A dedicated role that may only create databases would be narrower.
- The release job's actions are pinned by tag, not by commit; the update key's password is kept next to the key on the owner's offline copy.
- `db/tests/privileges.test.ts` could also check that only `auth.device_activity` allows a table-wide UPDATE by the API.

## Checked and working (summary)

- **Every route declares its access** or the server refuses to start; unknown permission codes stop it too. 248 routes: 203 need a permission (54 different ones), 23 a signed-in session (own account, approvals, reference lists), 12 are public (`/health`, two enrollment steps, nine first-run setup steps behind the installer's token, from the server PC only), 10 need an enrolled PC only (sign-in, the PIN list, password recovery, the kiosk state, the version).
- **The database holds the line on its own:** the API cannot delete business records, change the audit log, move a number, edit a posted document or journal entry, or grant itself a permission; owner-only permissions and approvals are enforced by triggers.
- **TLS 1.3 only** with the shop's own CA (name constraints checked); the PCs trust only that CA; enrollment proves the server is genuine; device keys never leave the PC.
- **Secrets** sealed with DPAPI per secret; the launcher refuses a folder that is too open and clears the environment (no `NODE_OPTIONS`, no planted variables); passwords, PINs and recovery codes are hashed with Argon2id.
- **Updates** are checked (SHA-256 and the update key's signature) before they are kept and again right before they run; only allowed file types are published.
- **Backups** are encrypted to the owner's key; a restore runs every integrity check before it replaces anything.
- **Emergency tool:** server PC only, administrator prompt, a reason for every reset, sessions ended, the temporary password never logged.
- **Kiosk:** turning it off needs the owner, a fresh phone code and a reason, capped in the database; every exit is audited and alerted.
- **The cashier's Windows account** is a standard account; an hourly check confirms it cannot open the data, secrets, backups or logs, nor stop the services.
- **Dependencies:** the weekly check is clean (no critical, high, medium or low advisory in the shipped code; 2026-11-07).

## Decisions for the owner (before go-live)

1. **One permission per secret file (M1, second half).** The setup and every upgrade give each service read access only to its own files (server: master key and the api password; backup service: master key and the backup password); the superuser, migrator and maintenance passwords and `tls\ca.key` are closed to SYSTEM and Administrators; the launcher opens only the files of the program it starts. Windows tests in GitHub check the server's account cannot read the other files, on a new installation and after an upgrade. About one day of work plus a Windows test round.
2. **Protect the shared enrollment on the server PC (M2).** The `device` folder becomes writable by SYSTEM and Administrators only; enrolling the server PC and renewing its key go through the updater (which runs as SYSTEM); the app also checks the CA in the enrollment against the administrator-only copy from the setup and refuses a mismatch. The PC's kind is taken from the server, not from the local file. About one to two days plus a Windows test round.
3. **Lock the laptop's update folder (M3).** Every run of the quiet updater makes SYSTEM the folder's owner, resets and checks its permissions (and stops if they are wrong), runs from Program Files, and holds the setup file open (no writing) between the check and the start. About half a day plus a Windows test round. Needed before the laptop is enrolled.
4. **The lock screen's owner code (L11):** after, say, three blocks in a day, keep the code entry closed on that PC until you unblock it (as for PINs and approvals)? It is stricter: if you mistype often you would need another PC to unblock it.

Recommendation: **1, 2 and 3 before go-live, in one more batch**; 4 as you prefer.
