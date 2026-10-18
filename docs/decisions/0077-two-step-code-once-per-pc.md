# 0077 — The 2-step code once per PC, until the password changes

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-18 |
| **Decided by** | Owner |
| **Changes** | [0027](0027-trust-this-pc-for-the-2-step-code.md) (how long a trust lasts, and the default of the box) |

## Decision
- The first sign-in of a 2-step user on a PC asks for the phone code, as before.
- The box under the code now reads **"Remember this PC: no phone code here until my password changes"** and is **ticked by default**. Untick it on a PC other people use.
- After that, on **that PC only**, the password alone signs the person in, with no time limit.
- On any other PC, the phone code is still asked the first time.
- Every ending of decision 0027 still applies: the trust ends when the password changes (changed, reset or recovered), the 2-step setup changes, the person is deactivated, or the PC is revoked or becomes a POS PC. The owner can still end it in **Settings → Devices**.
- Never on POS PCs.

## How it works
- Migration 0030: the setting `security.trusted_device_days` goes from 30 to **3650** (10 years, in practice "until the password changes"); its allowed range becomes 0–3650, and 0 still turns the feature off.
- Trusts that already exist keep their 30 days; the next phone code on that PC gives the long one.
- Settings → Devices shows such a trust as "until their password changes".

## Why
The owner signs in many times a day on their own PC. The phone code keeps its protection where it matters: a stolen password is useless on any other PC.
