# 0092 — First-run setup wizard on the server PC

| | |
|---|---|
| **Status** | Accepted (2026-10-19); extended by [0102](0102-first-run-new-setup-or-restore.md) (a second path: restore from backup) |
| **Date** | 2026-10-19 |
| **Decided by** | Owner |
| **Related** | [0025](0025-first-owner-and-pc-from-server-commands.md) (updated), [0022](0022-owner-2-step-recovery.md), [0024](0024-device-enrollment-proves-the-server.md), [0030](0030-company-details-owner-only.md) |

## Decision
- After the **server installer** finishes, the app on the server PC opens a **one-time setup wizard**. No PowerShell or console is needed:
  1. **Company details:** name (Arabic and English), TRN, address, logo.
  2. **The owner account:** names, username, password (0023). The first and only account created here.
  3. **Phone 2-step:** QR code + the 6-digit code to confirm (0022).
  4. **Recovery codes:** shown once, print or save; the owner must confirm before continuing.
  5. **Enroll this PC as the POS device** (0024, 0082).
- **Runs only once, only on the server PC, then locked.** The database records that setup is complete and refuses every setup step afterwards; the setup endpoints also answer only to the server PC itself.
- The console commands of 0025 (`owner:create`, `device:code`, `owner:reset-2fa`, `owner:reset-password`) stay as **emergency tools only**, documented in a runbook.

## Why
The owner installs and sets up the system himself, with screens, in Arabic or English.

## How it works (to build in M6 part 2)
- A one-row setup state in the database (`not_started` → `complete`, never back), changed only by the setup functions; every step is audited as the SYSTEM user with "setup wizard".
- The security details (how the wizard proves it is on the server PC and started by the installer) are planned and approved with part 2.
