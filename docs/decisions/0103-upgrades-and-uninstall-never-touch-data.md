# 0103 — Upgrades and uninstall never touch the data; updates go from a USB drive to the server, then over the shop network

| | |
|---|---|
| **Status** | Accepted (2026-10-20); the "updates without internet" part (USB → server → PCs, offline key) replaced by [0108](0108-automatic-online-updates.md) (automatic online updates); USB stays as a support fallback |
| **Date** | 2026-10-20 |
| **Decided by** | Owner |
| **Related** | [0007](0007-no-code-signing-certificate-for-now.md) (extended), [0086](0086-backups-local-and-google-drive.md), [0085](0085-server-on-the-pos-pc.md) |

## Decision

**Where things live.** The program in `C:\Program Files\ARTEPOOL\`; the data in `C:\ProgramData\ARTEPOOL\` (database, write-ahead log archive, backups, logs, secrets, settings). An installer replaces only the program.

**Upgrade** (a newer installer on an installed PC):
1. the data is kept as it is;
2. the app and the server service stop;
3. a **pre-upgrade backup** is made and checked (readable, checksum), in `backups\pre-upgrade\`;
4. the new program is put in place; the previous version is kept;
5. the new database changes (migrations) run **all-or-nothing**, in one transaction, after checking the ones already applied;
6. the services start and must answer.

If step 5 or 6 fails, the database is unchanged and the previous version is put back and started; the owner sees which step failed and where the pre-upgrade backup is.

**Uninstall** removes the program, the services, the start-up task and the firewall rule, and **keeps the data**. Installing again finds it and simply starts (no wizard).

**Deleting the data** is a separate choice, off by default. It needs the **owner's password** (checked against the database, audited) and typing `DELETE`. It removes the database, the log archive and the secrets. **The backups folder is always kept**; the owner deletes it by hand if he ever wants to.

**Updates without internet:**
- the owner copies the new version from a USB drive to the server PC (the server installer upgrades the server and keeps the new app update);
- the other PCs (laptop, a second POS) take the app update **from the server PC over the shop network**;
- the update is checked against the **update signature** (0007) and refused if the signature does not match. The private update key stays offline with the owner;
- every release comes with a `SHA256SUMS.txt` file to check the installer on the USB drive.

## Why
The data is the business. Nothing that installs, upgrades or removes the program may risk it, and a failed upgrade must leave the shop working on the version it had.

## Consequences
- The migration runner gets an "all-or-nothing" mode for upgrades (development keeps one transaction per file).
- Windows-runner tests: install, add data, upgrade (kept); a broken migration (database unchanged, old version running); uninstall and reinstall (kept, no wizard); delete data with a wrong password (nothing deleted) and with the right one (database gone, backups kept).
