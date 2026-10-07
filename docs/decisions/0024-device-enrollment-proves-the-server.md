# 0024 — Device enrollment: a 10-minute one-time code that also proves the server is genuine

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Decided by** | Owner |

## Decision
- **Creating a code:** the owner creates an enrollment code in Settings → Devices.
  - The code is valid for **10 minutes** and works **once**.
  - Creating a new code cancels any earlier unused one.
- **On the new PC:** someone types the server address and the code. The code does two jobs:
  1. It proves to the server that this PC was invited.
  2. It proves to the PC that it is talking to the **genuine ARTÉPOOL server**, so it can safely trust the server's certificate.
- **Nothing needs to be copied by hand** to the new PC, for example with a USB stick.

## Why
- A new PC does not yet know the private ARTÉPOOL certificate. Something must link the two securely the first time. The code that the owner reads out is already a shared secret, so it is used for both jobs.

## How it works
- **Format:** 9 characters, with look-alike characters (0/O, 1/I/L) left out. It is shown as `XXX-XXX-XXX`.
- **How the code is checked:**
  - The server stores only a slow (Argon2id) key derived from the code, never the code itself.
  - The code never travels over the network. Both sides prove they know it with a keyed checksum (HMAC) over the server's certificate and fresh random values.
  - A fake server cannot produce a valid proof, so the PC refuses to continue.
- **Against guessing:**
  - Attempts are rate-limited.
  - A code is cancelled after 5 wrong attempts.
- **After enrollment:**
  - The PC trusts **only** the ARTÉPOOL certificate. It connects with TLS 1.3 and checks the server's name.
  - The PC receives its own random 256-bit device key. The key is kept in Windows Credential Manager, and the server stores only its SHA-256.
  - The device key is valid for a year and renews itself automatically before it expires. Settings shows the date in the "Key valid until" column.
- **Device details:** the person enrolling confirms the PC's name (the Windows computer name is suggested) and its type: POS, office or warehouse. The owner can change both later in Settings.
- **Logging:** each code created, cancelled or used, and each failed attempt, is written to the audit log.

## Consequences
- **Supersedes** the 15 minutes in `architecture.md`. The setting `security.enrollment_code_minutes` defaults to 10.
- **Settings table:** enrollment codes get their own table, `auth.enrollment_codes`. The `auth.devices` table holds only enrolled devices, with status `active` or `revoked`.
