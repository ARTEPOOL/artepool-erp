# 0085 — The server runs on the POS PC: services, accounts and permissions

| | |
|---|---|
| **Status** | Accepted (2026-10-19) |
| **Date** | 2026-10-18 |
| **Decided by** | Owner |

## Decision
- **Topology now:** the POS PC is also the Main Server (PostgreSQL + API as Windows services). The owner's laptop is the only Office PC. A read-only mobile dashboard comes in Phase 2 (0088).
- **The installer (M6):**
  - runs PostgreSQL and the API as **Windows services under their own service accounts** (not the cashier, not an administrator), starting automatically, restarting on failure;
  - PostgreSQL listens on localhost only; the firewall allows only the API port, from the LAN only (no VPN in Phase 1, [0093](0093-no-remote-access-in-phase-1.md));
  - sets **restrictive permissions (ACLs)**: the database folder, `.secrets` (master key, TLS keys, backup settings), backups and logs are readable only by the service accounts and the administrator; the cashier account cannot read them or stop the services;
  - creates the cashier's Windows account as a **standard user** (not an administrator) with **automatic sign-in** to the POS app (0082), with the kiosk policies of 0082 (no Task Manager, Run box or command prompt);
  - when the owner turns the kiosk lock off (0089, 0091), only the app lock is lifted: these Windows restrictions stay;
  - keeps an administrator account for the owner only;
  - recommends disk encryption where the Windows edition offers it (BitLocker, or Device encryption on Home; 0106) and records that a **UPS** is connected.
- **Health screen:** shows the services, the disk, the last backups, and a **UPS reminder** until the owner confirms one is installed (and again every 6 months).

## Why
With one PC for both jobs, the cashier sits at the server: the operating system must stop them from touching the database, the keys or the services.

## Risks accepted
- If this PC fails, the POS and the server stop together: the restore runbook and a spare PC are the answer (0086).
- Auto sign-in keeps the cashier account's Windows password on the PC; that account has no rights beyond the POS.
