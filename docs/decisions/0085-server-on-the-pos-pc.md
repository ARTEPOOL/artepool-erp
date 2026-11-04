# 0085 — The server runs on the POS PC: services, accounts and permissions

| | |
|---|---|
| **Status** | Accepted (2026-10-19) |
| **Date** | 2026-10-18 |
| **Decided by** | Owner |
| **Updated** | 2026-11-04: the cashier account simplified (M6.4): no Windows limits for now; the PC's enrollment shared by both accounts on the server PC; Windows Update active hours 08:00–24:00 |

## Decision
- **Topology now:** the POS PC is also the Main Server (PostgreSQL + API as Windows services). The owner's laptop is the only Office PC. A read-only mobile dashboard comes in Phase 2 (0088).
- **The installer (M6):**
  - runs PostgreSQL and the API as **Windows services under their own service accounts** (not the cashier, not an administrator), starting automatically, restarting on failure;
  - PostgreSQL listens on localhost only; the firewall allows only the API port, from the LAN only (no VPN in Phase 1, [0093](0093-no-remote-access-in-phase-1.md));
  - sets **restrictive permissions (ACLs)**: the database folder, `.secrets` (master key, TLS keys, backup settings), backups and logs are readable only by the service accounts and the administrator; the cashier account cannot read them or stop the services;
  - a **standard** (not administrator) cashier Windows account `artepool-pos` («الكاشير») with **automatic sign-in**; the app starts on the PIN screen in its kiosk lock (0082). Its random password is kept only as the Windows LSA secret. It is set up or repaired from the emergency tool (0107) and disabled, never deleted, by uninstall ([M6.4](../milestones/m6.4-cashier-windows-account.md));
  - **simplified (owner, 2026-11-04):** no Windows limits on that account for now (Task Manager, command prompt, Settings, browser, shutdown, sign-out/lock, USB). Its protection is being a standard user: it cannot open the folders above or stop the services, which is verified by System health and by the Windows CI. The limits can be added later if a real problem appears;
  - the PC's enrollment is kept for the whole PC on the server PC, so the owner's and the cashier's accounts use the same enrolled PC;
  - Windows Update active hours 08:00–24:00, so it never restarts during shop hours;
  - keeps an administrator account for the owner only;
  - recommends disk encryption where the Windows edition offers it (BitLocker, or Device encryption on Home; 0106) and records that a **UPS** is connected.
- **Health screen:** shows the services, the disk, the last backups, and a **UPS reminder** until the owner confirms one is installed (and again every 6 months).

## Why
With one PC for both jobs, the cashier sits at the server: the operating system must stop them from touching the database, the keys or the services.

## Risks accepted
- If this PC fails, the POS and the server stop together: the restore runbook and a spare PC are the answer (0086).
- Auto sign-in keeps the cashier account's Windows password on the PC; that account has no rights beyond the POS.
