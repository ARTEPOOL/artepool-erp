# 0104 — Minimum Windows and hardware; test on a clean virtual machine before the shop PC

| | |
|---|---|
| **Status** | Accepted (2026-10-20) |
| **Date** | 2026-10-20 |
| **Decided by** | Owner |
| **Related** | [0085](0085-server-on-the-pos-pc.md), [0007](0007-no-code-signing-certificate-for-now.md) |

## Decision

| | Minimum | Recommended |
|---|---|---|
| **Server / POS PC** | Windows 10 22H2 or Windows 11, 64-bit; 4-core x64 CPU; 16 GB RAM; SSD with 60 GB free; wired network; a reserved address on the router (0105); UPS | Windows 11 Pro (23H2 or newer); 256 GB+ SSD; 1920 × 1080 touch screen |
| **Owner's laptop / office PC** | Windows 10 22H2 or 11, 64-bit; 8 GB RAM; 1366 × 768 | Windows 11 |

Windows 10 no longer gets Microsoft's updates since October 2025 (only with paid extended updates): Windows 11 is recommended for the server PC.

**Pro or Home.** The shop PC is believed to be Windows 10 **Pro** (the owner confirms). Everything in the system works on **Home** too, except:

| Protection (M6.4) | Pro | Home |
|---|---|---|
| **BitLocker** (the disk is unreadable if the PC is stolen) | Yes | **No.** Some new PCs have "Device encryption" instead (needs a TPM and a Microsoft account); otherwise no disk encryption |
| Cashier account limits: no Task Manager, no Run box, no command prompt | Yes | Yes (set by the installer in the registry, not by Group Policy) |
| Standard cashier account, automatic sign-in, owner-only administrator | Yes | Yes |
| Folder permissions on the database, secrets, backups, logs | Yes | Yes |
| Services under their own accounts, firewall rule | Yes | Yes |
| **Windows Update restarts** under control (postpone feature updates, set when restarts may happen) | Full control | **Limited**: pause up to 5 weeks, "active hours" only; a restart can come at a bad time |
| Kiosk lock, watchdog, start with Windows | Yes | Yes |

So on Home the shop loses only **disk encryption** (unless the PC has Device encryption) and **full control of update restarts**.

**Test order.** Every installer is first tested on a **clean Windows 11 virtual machine** (Microsoft's free evaluation image in VirtualBox, or Hyper-V on a Pro PC). Take a snapshot before installing, so each test starts clean. A second VM plays the laptop. **Only after the VM checklist passes** is the shop PC installed.

**Unsigned installer (0007).** Windows SmartScreen shows "Windows protected your PC". The Arabic install guide shows that screen and the steps **More info → Run anyway**. It explains that the installer is checked with its SHA-256 from `SHA256SUMS.txt`, and that the app's updates are signed and refused if not (0103).

## Why
The shop PC holds the business. It is installed only after the same steps have passed on a machine that can be thrown away.
