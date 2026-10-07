# 0025 — The first owner and the first PC are created by commands on the server PC

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Decided by** | Owner |

## Decision
On a new installation nobody can sign in yet, so two commands run **on the server PC itself**:

| Command | What it does |
|---|---|
| `pnpm owner:create` | Asks for the owner's username, names in Arabic and English, and password (decision 0023). It works only while there is **no active owner**. The owner sets up the 2-step code at the first sign-in. |
| `pnpm device:code` | Prints a one-time enrollment code, under the same rules as Settings (decision 0024). Use it to enroll the first PC, or to recover if no enrolled PC is left. |
| `pnpm owner:reset-2fa` | The emergency reset from decision 0022. |

## Why
- No screen can create the first account, because no one can sign in to reach it.
- The commands need the server's own database credentials, and the database accepts connections only from the server PC itself. Only someone sitting at the server PC can run them.

## How it works
- **Audit:** each command writes to the audit log as the built-in SYSTEM user, with a fixed description and, where asked, a reason. The log shows it came from the server console.
- **Development:** the commands are `pnpm` scripts.
- **Production:** the M6 installer provides the same commands for the installed server.
- **Secrets:** passwords and codes are typed or shown only in the console window. They are never written to a file or a log.

## Consequences
- **Exactly one active owner:** a second owner cannot be created from the Settings screen.
- **Changing the owner:** handing the owner role to someone else is a later server-console task, not part of M1.
