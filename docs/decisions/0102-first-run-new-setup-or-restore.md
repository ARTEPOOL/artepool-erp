# 0102 — First run: "New setup" or "Restore from backup"; the master key travels inside the encrypted backups

| | |
|---|---|
| **Status** | Accepted (2026-10-20); amended 2026-10-24 (a Google Drive copy is downloaded first, see below) |
| **Date** | 2026-10-20 |
| **Decided by** | Owner |
| **Related** | [0092](0092-first-run-setup-wizard.md) (extended), [0086](0086-backups-local-and-google-drive.md) (extended), [0024](0024-device-enrollment-proves-the-server.md), [0026](0026-users-and-devices-never-deleted.md) |

## Decision

The one-time wizard on the server PC (0092) offers **two paths**. Either one locks the wizard for good when it finishes.

1. **New setup:** company details → the owner account → phone 2-step → recovery codes (confirmed) → enroll this PC as the POS. As 0092.
2. **Restore from backup** (a new server PC after loss or damage):
   - choose a copy: from this PC, a USB drive (or the external-drive `ARTEPOOL-BACKUPS` folder), or Google Drive. *Amended 2026-10-24 (the owner approved the restore plan):* a Google Drive copy is downloaded first from drive.google.com in a browser (on any PC) and then chosen like a USB copy; the wizard finds copies by itself on USB drives and in Downloads, Desktop and Documents, or takes a typed path. No Google sign-in is needed while the shop is down, and the copy is still opened only with the private key;
   - enter the owner's **private backup key** (typed, or loaded from the USB key file);
   - the copy is restored into a separate database and **checked**: audit chain, the copy's anchor, journals balanced, trial balance, stock against the ledger, numbering;
   - **only if every check passes** does it become the live database. Otherwise nothing is replaced and the reason is shown;
   - then a fresh backup and a restore test run.

**The server's master key travels inside the encrypted backups.** The copies encrypted with the owner's backup key (Google Drive and the encrypted USB copy) also carry the master key. Only the owner's offline private key opens them. After a restore:
- passwords, phone 2-step and the other sealed values keep working;
- the backup key stays the same (its public part is in the database).

**After a restore, every other PC is enrolled again** with a new code (0024). The new server PC has its own new certificate authority, so the old PCs cannot connect to it, and they are marked "enroll again". The owner makes a code for each in Settings → Devices. The Google Drive connection is made again.

**Security of the wizard:** both paths answer only when setup is not complete, only on the server PC itself (127.0.0.1), and only with the installer's one-time setup token (readable by Windows administrators only, deleted at the end). Every step is audited as SYSTEM with "setup wizard". The database keeps the setup state and never lets it go back.

## Why
A damaged or stolen server PC must not mean starting again from nothing. The owner restores everything himself, with screens, from a copy only he can open. Carrying the master key inside copies that only the owner's offline key opens keeps everyone's sign-in working, without weakening anything: whoever has the copy and the private key already has all the data.

## Consequences
- The restore runs as a Windows administrator (the wizard already is one: only administrators can read the setup token). The PostgreSQL superuser's password is a sixth protected secret, given only to the restore program, never to the services.
- The encrypted copy is a small bundle: the database copy and the sealed keys, both encrypted for the owner's backup key. Older copies (database only) still restore; then 2-step must be set up again with the emergency reset (0029).
- The unencrypted hourly copies on the server PC itself do not carry the master key (it is on that PC already).
