# 0086 — Backups: hourly local, daily encrypted to Google Drive, weekly external drive

| | |
|---|---|
| **Status** | Proposed — waiting for the owner's approval |
| **Date** | 2026-10-18 |
| **Decided by** | Owner (requirements); details proposed |

## Decision
- **Hourly local backup** on the server PC (plus continuous WAL archiving for point-in-time restore), kept on a separate disk or partition when there is one.
- **Daily off-site copy to Google Drive**, **encrypted with `age` before upload**: Google only ever stores encrypted files. The server holds only the public key; the **private key is kept offline by the owner** (printed and on a USB stick in a safe place). Retention: 30 daily + 12 monthly.
- **Weekly external-drive reminder:** the health screen asks the owner to plug in the backup drive; the copy runs, the drive is unplugged (a copy that ransomware cannot reach).
- **Restore test** as planned (M6): a one-click restore into a test database with the integrity checks, and a monthly reminder.
- The Google account used for backups has its own 2-step verification; its access token is stored encrypted on the server (DPAPI), never in the database or in plain text.
- Every backup run, failure and restore test is recorded and alerts the owner when a backup is late.

## Why
3-2-1: three copies, two kinds of storage, one off the premises, while Google never sees the shop's data.

## Consequences
- Losing the private key makes the off-site copies useless: keep two offline copies of it.
