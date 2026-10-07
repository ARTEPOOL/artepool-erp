# 0023 — Password rules

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Decided by** | Owner |

## Decision
- **Length:** at least **10 characters**, and at most 128.
- **Refused:**
  - common passwords, from a bundled list checked without regard to capital letters
  - passwords that contain the username
  - passwords made of one repeated character
- **No forced symbols or digits**, and **no forced expiry**.
- **A password change ends the user's other sessions** on every other PC.

## Why
- Current security guidance (for example NIST SP 800-63B) favours long passwords and blocking known-bad ones. Forced symbols and regular expiry lead people to weaker, predictable passwords.

## How it works
- **Hashing:** passwords are hashed with Argon2id. The hash stores its own settings, so the strength can be raised later without asking anyone to change their password.
- **Owner reset:** when the owner resets someone's password, the system creates a temporary password and shows it once. The user must choose their own at the next sign-in. The reset also ends all of that user's sessions.
- **Lockout:** 5 wrong passwords lock the account for 15 minutes (settings `security.max_failed_logins` and `security.lockout_minutes`). The owner can unlock it sooner from Settings.
- **Messages:** a wrong password and an unknown username give the same message, so nobody can find out which usernames exist.
- **Logging:**
  - Passwords are never logged or shown. Error messages do not repeat them.
  - Every change, reset, lockout and unlock is written to the audit log.

## Consequences
- The minimum length is a setting (`security.password_min_length`, default 10). The owner can raise it, but not below 10.
