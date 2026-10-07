# 0022 — Owner 2-step code: recovery codes and a server-only emergency reset

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Decided by** | Owner |

## Decision
- **First sign-in:** the owner sets up the 2-step code by scanning a QR code with an authenticator app. The app works offline.
- **Recovery codes:** **10 one-time recovery codes** are created at the same moment and **shown once**. The owner prints them and keeps them in the safe.
  - A recovery code replaces the 6-digit code **once**. The password is still required.
  - After a recovery-code sign-in, the owner must set up the 2-step code again, on the new phone. This produces a new QR code and 10 new recovery codes, and the old ones stop working.
- **Emergency reset (phone and codes both lost):** a command that works **only on the server PC itself**. It clears the owner's 2-step setup, so the next sign-in asks for a new one.
  - It requires a written reason.
  - It is recorded in the audit log.

## Why
- Without a way back, losing the phone would lock the owner out of the system, because Settings are owner-only.
- Recovery codes cover the usual case. The server-only command covers the rare case where the codes are lost too.
- Only someone who can sit at the server PC can use the command, so it is not a back door from the network.

## How it works
- **Storage:**
  - The 2-step secret is stored encrypted (AES-256-GCM). Its key is kept outside the database.
  - Recovery codes are stored only as Argon2id hashes, like passwords.
  - Each code is marked as used once, and the mark is never removed.
- **Replay:** the same 6-digit code is never accepted twice.
- **Logging:** each use of a recovery code, each new setup and each emergency reset is written to the audit log.
- **Command name:** `pnpm owner:reset-2fa` (decision 0025 lists all the server commands).

## Consequences
- The owner should print the recovery codes on day one and store them away from the phone.
