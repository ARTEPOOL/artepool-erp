# 0028 — Forgot password: recover it in the app with the phone code and one recovery code

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Decided by** | Owner |

## Decision
- **Where:** the sign-in screen has a **"Forgot your password?"** link. It opens a screen that asks for:
  - the username;
  - the 6-digit code from the phone;
  - **one** recovery code (from the 10 printed at 2-step setup, decision 0022);
  - a new password, typed twice. The usual password rules apply (decision 0023).
- **Who:** everyone who uses the 2-step code (the owner, and anyone set to "Password + 2-step code"). Other staff ask the owner, who resets their password in **Settings → Users** as before.
- **When it succeeds:**
  - the new password is saved;
  - the recovery code is used up (the screen says how many are left);
  - the account is unlocked;
  - every session of that person, on every PC, ends;
  - every trusted PC of that person stops being trusted (decision 0027);
  - the person is signed in on this PC.
- **The phone stays set up.** The 6-digit code proved the phone is still in the person's hands, so no new QR code is needed.
- **It also works when the account is locked** after wrong passwords. That is the most common moment someone needs it, and it asks for two things only the owner has.
- **Wrong attempts:**
  - The message is the same whichever part was wrong, so it reveals nothing.
  - Each wrong attempt counts as a failed sign-in.
  - Attempts are limited per PC.
  - Every attempt is written to the audit log.
- **Only on enrolled PCs,** like signing in.

## Why
- The owner has nobody above them to reset their password. Before this decision, a forgotten owner password meant starting the database again, which is impossible once real data exists.
- Asking for **both** the phone code and a recovery code keeps it as strong as a normal sign-in or stronger. The recovery code alone is about 50 bits of randomness and is used once. The phone code proves the phone is present.

## How it works
- **One transaction:** the 6-digit code and the recovery code are checked and claimed together with the password change. If the same code arrives twice at once, only one attempt wins.
- **Replay:** the 6-digit code is never accepted twice. The recovery code is marked as used, and the mark is never removed.
- **Password rules first:** the new password is checked against the rules before any code is used up, so a refused password does not waste a recovery code.
- **Audit log:** the event "password recovered", with the number of recovery codes left. It never contains the codes or the password.

## Consequences
- Each recovery uses up one of the 10 recovery codes. Setting up the 2-step code again (for example on a new phone) gives 10 new codes.
- If the phone, the recovery codes **and** the password are all lost, the app cannot recover the account.
  - The server-PC command `pnpm owner:reset-2fa` clears only the 2-step setup. It does not reset the password.
  - A server-PC password command is still an open question for the owner.
