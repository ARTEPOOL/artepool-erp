# 0007 — No code-signing certificate for now

| | |
|---|---|
| **Status** | Accepted (revisit later); extended by [0103](0103-upgrades-and-uninstall-never-touch-data.md) (upgrades keep the data), [0108](0108-automatic-online-updates.md) (automatic online updates signed in GitHub after the owner's approval) and [0104](0104-windows-and-hardware-test-on-a-vm-first.md) (SmartScreen steps in the guide) |
| **Date** | 2026-10-06 |
| **Decided by** | Owner |

## Decision
No Windows code-signing (Authenticode) certificate for now. We rely on **signed updates**.

## How it works
- **Updates are always signed.** Every app update is signed with the ARTÉPOOL update key. The app refuses any update whose signature does not match. The private key is kept offline and never in the repository.
- **Installers are unsigned.** Windows SmartScreen may show "unknown publisher" when the app is first installed. The runbook explains how authorised staff install it.
- **Installers come only from trusted sources:** the Main Server or the owner's USB drive. A SHA-256 checksum is published with every release so the file can be verified.

## Revisit when
- SmartScreen warnings become a nuisance, more PCs are added, or company policy requires signed installers. The options then are an OV certificate or a cloud signing service.
