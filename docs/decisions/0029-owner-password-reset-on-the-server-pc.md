# 0029 — Emergency owner password reset on the server PC

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Decided by** | Owner |

## Decision
- **Command:** `pnpm owner:reset-password`. It is the last way back when the owner's password is lost **and** "Forgot your password?" (decision 0028) cannot be used, because the phone or the recovery codes are lost too.
- **Where:** only on the server PC. Only that PC holds the database credentials, so it cannot be run from another PC or over the network.
- **What it asks:**
  - a written reason (required);
  - whether the phone is lost too (yes / no);
  - the word `RESET` typed to confirm.
- **What it does:**
  - **A temporary password,** shown once on the screen, that must be changed at the next sign-in.
  - **Unlocks the account** (clears the wrong-password lockout).
  - **Ends every session of the owner** on every PC. **No PC stays trusted** (decision 0027).
  - **If the phone is lost too,** the 2-step setup is cleared and the old recovery codes stop working. After choosing a new password, the owner sets up the new phone and gets 10 new recovery codes. If the phone is not lost, the 6-digit code is still asked.
  - **Writes an audit entry** "Owner password reset on the server PC", with the reason.
- **A notice for the owner:** on the "Choose your own password" screen after the reset, the app says when the password was reset on the server PC and with which reason. That way the owner sees it if someone else did it.

## Why
- Without it, losing the password, the phone and the recovery codes together would lock the owner out for good. Settings are owner-only, and once real invoices and accounts exist, starting the database again is not an option.
- The command adds no back door from the network. Anyone who can use the server PC as an administrator is already close to the data. The real protection is the server PC itself: a locked room, a Windows password, and disk encryption where Windows offers it (PRD security requirements, 0106).

## How it works
- **Same shape as `pnpm owner:reset-2fa`** (decision 0022). It runs as SYSTEM with a "server console" reason, in one transaction.
- **Temporary password:** `XXXX-XXXX-XXXX` (about 59 bits), stored only as an Argon2id hash, and marked "must change".
- **Trusted PCs:** the database ends every trusted PC of the owner by itself when the password is reset (decision 0027).
- **The notice** is read from the audit log: the latest "owner password reset" entry that is newer than the owner's last own password change.

## Consequences
- Keep the server PC physically safe: locked room, a Windows password, disk encryption where available (0106).
- Every use is visible in the audit log, and the hash chain detects any later tampering with it.
