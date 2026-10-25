# 0107 — "ARTÉPOOL – Emergency tool": a window instead of commands on the server PC

| | |
|---|---|
| **Status** | Accepted in principle (2026-10-25, the owner's request for Part F); the list of actions below is to be confirmed by the owner |
| **Date** | 2026-10-25 |
| **Decided by** | Owner |
| **Related** | [0025](0025-first-owner-and-pc-from-server-commands.md), [0029](0029-owner-password-reset-on-the-server-pc.md), [0022](0022-owner-2-step-recovery.md), [0092](0092-first-run-setup-wizard.md), [0103](0103-upgrades-and-uninstall-never-touch-data.md), [0106](0106-every-windows-edition.md) |

## Decision
No command is ever needed at the shop. The emergency tools of 0025, 0029 and 0022 (`owner:reset-password`, `owner:reset-2fa`, `device:code`) are reached through a window, **ARTÉPOOL – Emergency tool**, in the Start menu of the server PC only.

- **Who and where:**
  - it opens only through Windows' administrator prompt (UAC); a standard (cashier) account cannot open it;
  - it works only on the server PC: the installation's settings file, the launcher and the protected secrets must be there;
  - on any other PC it says so and does nothing.
- **What it does** (each in Arabic and English, each with a written reason where the earlier decision asks for one):
  1. **Owner's password:** a temporary password shown once, the owner chooses their own at the next sign-in (0029).
  2. **Owner's phone code (2-step):** cleared when the phone and the recovery codes are both lost; the owner sets it up again at the next sign-in (0022).
  3. **Enrollment code for a PC:** a one-time 10-minute code, as in Settings → Devices (0024, 0025).
  4. **Check the system:** the services (database, server, backups), the protected secrets and the database answer; each line green or red, never a value of a secret.
  5. **Open the logs folder** (`C:\ProgramData\ARTEPOOL\logs`), to send it to support.
- **Same rules as the commands:**
  - each action is the same server code as the console command, run through the launcher (`artepool-svc run …`) with the protected secrets;
  - each action is written to the audit log with its reason;
  - the console commands stay for support (0092).
- **Every Windows edition** (0106): the administrator prompt comes from the program's own Windows manifest, not from any policy.

## Why
The owner is not a technician. When the owner is locked out, the person at the shop must be able to fix it with a few clicks, without typing commands, while a cashier still cannot.

## Consequences
- The console programs gain a non-interactive mode (JSON in, JSON out) for the window. The interactive prompts stay for support.
- The window is part of the desktop app: same screens, same languages and design. A small launcher (`artepool-emergency.exe`), which asks for administrator rights, opens it.
- Installed by the server installer only (Part F); removed by its uninstaller.
