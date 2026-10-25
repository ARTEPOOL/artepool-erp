# 0086 — Backups: hourly local, daily encrypted to Google Drive, weekly external drive

| | |
|---|---|
| **Status** | Accepted (2026-10-19); extended by [0102](0102-first-run-new-setup-or-restore.md) (the master key inside the encrypted copies; restore in the first-run wizard) |
| **Date** | 2026-10-18 |
| **Decided by** | Owner |

## Decision
- **Hourly local backup** on the server PC (plus continuous WAL archiving for point-in-time restore), kept on a separate disk or partition when there is one.
- **Daily off-site copy to Google Drive**, **encrypted with `age` before upload**: Google only ever stores encrypted files. The server holds only the public key; the **private key is kept offline by the owner** (printed and on a USB stick in a safe place). Retention: 30 daily + 12 monthly.
- **Weekly external-drive reminder:** the health screen asks the owner to plug in the backup drive; the copy runs, the drive is unplugged (a copy that ransomware cannot reach).
- **Restore test** as planned (M6): a one-click restore into a test database with the integrity checks, and a monthly reminder.
- A **dedicated Google account used only for the encrypted backups**, with 2-step verification; its access token is stored encrypted on the server (DPAPI), never in the database or in plain text.
- Every backup run, failure and restore test is recorded and alerts the owner when a backup is late.

## Owner's choices (M6.1 plan, 2026-10-19)
- **The key is created in the app once:** Settings → Backup → Create backup key; the private key is shown once (print / save to a USB stick / copy), confirmed by typing its last 6 characters, and never stored by the server; only the public key is kept (setting `backup.age_recipient`). X25519 keys, readable by the standard `age` tool.
- **Google Drive permission: the app's own files only** (`drive.file`); old copies go to the Drive trash by the retention rule. Connected by choosing the account in the browser, with a code at google.com/device as fallback; the app's Google registration is built into the installation ([0095](0095-google-drive-connect-by-choosing-the-account.md)).
- **The external-drive copy is not encrypted** (owner's choice): the drive must be kept locked away.
- **System health and the backup alerts are for the owner only** (health view, restore test, integrity checks and the new `system.backup.manage` are owner-only permissions).

## How it works (built in M6.1)
- A separate backup service (`apps/backup`, role `artepool_backup`: reads everything, writes only its own records; may create the throwaway restore-test database). Every run is in `ops.backup_runs`, every check in `ops.integrity_runs`, the owner's requests in `ops.backup_requests` (migration 0036).
- Local: `pg_dump` (custom format) every hour, checked with `pg_restore --list`, SHA-256 and the audit chain head recorded (also as an `audit.anchors` row of kind `backup`); kept: every copy of the last 48 hours + the first of each of the last 30 days.
- Off-site: the newest local copy encrypted with the public key, uploaded daily; kept: first of each of the last 30 days + of each of the last 12 months. The Drive refresh token is sealed with the master key in `.secrets` (never in the database or a log).
- External drive: a fresh copy to `<drive>\ARTEPOOL-BACKUPS`, verified byte for byte, the last 8 kept.
- Restore test: the newest copy restored into a throwaway database that no other role may open; checks: audit chain, journals balanced, trial balance, stock = movements, gapless numbering; the database is then dropped. The same checks run on the live database every night after 02:00 (Dubai).
- Alerts (checked by the API every 5 minutes, one per problem per day): local copy late (> 90 min) or failed, off-site late (> 30 h) or failed, restore test due (30 days) or failed, external-drive copy due (7 days), integrity issues. The health screen also shows "off-site not set up" and "disk nearly full".
- WAL archiving (point-in-time restore) and running the service at Windows start come with the installer (M6.2).
- Runbook: [backup-and-restore.md](../runbooks/backup-and-restore.md).

## Why
3-2-1: three copies, two kinds of storage, one off the premises, while Google never sees the shop's data.

## Consequences
- Losing the private key makes the off-site copies useless: keep two offline copies of it.
