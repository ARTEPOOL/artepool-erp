# 0106 — Every Windows 10 and 11 edition (Home, Pro, Enterprise); no Pro-only feature

| | |
|---|---|
| **Status** | Accepted (2026-10-24) |
| **Date** | 2026-10-24 |
| **Decided by** | Owner |
| **Related** | [0104](0104-windows-and-hardware-test-on-a-vm-first.md) (amended), [0085](0085-server-on-the-pos-pc.md), [0103](0103-upgrades-and-uninstall-never-touch-data.md) |

## Decision

- The system runs on **Windows 10 (22H2) and Windows 11, 64-bit, every edition: Home, Pro and Enterprise**, not only on the shop PC's Windows 10 Pro.
- **Nothing depends on a Pro-only feature.** Where Pro has something Home lacks, the system uses a way that works on Home too:

| Need | Not used (Pro-only) | Used instead (every edition) |
|---|---|---|
| Cashier account limits (no Task Manager, Run box, command prompt) | Group Policy, `gpedit.msc` | The same settings written by the installer in the registry (`…\Policies\System`, `…\Policies\Explorer`), which Home honours |
| Standard cashier account, owner-only administrator | "Local Users and Groups" (`lusrmgr.msc`) | `net user` / PowerShell `New-LocalUser`, present on Home |
| Disk encryption | Requiring BitLocker | **Recommended, not required:** BitLocker where the edition has it, "Device encryption" on Home PCs whose hardware supports it. The health screen says whether the system disk is encrypted. The data that matters most is protected on every edition: the secrets by DPAPI, the off-site copies by the owner's age key |
| Restarts after Windows updates | Update policies (deferral, restart windows) | "Active hours" set by the installer, and the health screen's reminder; on Pro the owner may also defer feature updates |
| Testing on a virtual machine | Hyper-V | VirtualBox (free), on any edition |
| Services, protected secrets, folder rules, firewall | — | Windows services with virtual accounts, DPAPI, `icacls`, Windows Firewall: all present on Home |

- **The installer, the Windows services, the protected secrets (DPAPI) and the restore wizard work on Home**, and are tested there.
- **Go-live checklist:** the VM test steps run on **Windows 11 Home and Windows 10 Home** as well as on Pro, before the shop PC is installed.
- **Windows 10 warning:** the first-run setup screen warns when the PC runs Windows 10: it no longer gets free security updates from Microsoft, so upgrading to Windows 11 (or buying Microsoft's extended updates) is advised. It **never blocks** the installation.

## Why

A shop may replace its server PC with whatever is in stock, often a Home edition. The system must not depend on the edition, and the owner must know when Windows itself is out of support.

## Consequences

- Decision 0104's "Pro for BitLocker" becomes a recommendation; nothing in M6.2–M6.4 needs Pro.
- The setup screen learns the Windows build from the PC (build 22000 and later is Windows 11).
