# Changelog

## M1 — Security core and app shell (2026-10-07)

**In plain words:** only enrolled PCs can talk to the server, over an encrypted connection; people sign in safely (password, cashier PIN on POS PCs, owner's phone code); and the owner manages users, PCs and the audit log in Settings — in Arabic and English, light and dark, matching the approved design. Proven by 158 unit, 233 integration, 26 Rust and 28 browser tests.

- **Enrolling a PC:** a 10-minute, one-time code that also proves the server is genuine; the PC then trusts only the ARTÉPOOL certificate (TLS 1.3) and keeps its own key in Windows Credential Manager; the key renews itself every year.
- **Signing in:**
  - passwords of 10+ characters, common ones refused, 5 wrong tries lock the account for 15 minutes;
  - cashiers pick their name and type a 4-digit PIN, on POS PCs only; weak PINs refused; blocked after 5 wrong tries until the owner unblocks it;
  - the owner adds a 6-digit code from the phone; 10 one-time recovery codes; an emergency reset on the server PC only;
  - a temporary password or PIN must be replaced at first sign-in;
  - idle screens lock (POS 5 minutes, office 15).
- **Every request is checked by the server:** the PC, the session, and a permission declared for every route (the server refuses to start otherwise). Saves are never done twice when retried.
- **Settings (design 13):** users (temporary code shown once, unlock, deactivate with a reason, reactivate — never deleted), roles and permissions (discount limits stored as whole numbers), PCs (new code, rename, revoke with a reason), and the audit log (chain check, filters, before/after, export).
- **The Windows app (Tauri):** one copy per PC; updates only with a valid signature (the key is created in M6); strict security policy.
- **CI:** Linux checks and tests, browser tests in both languages, Rust tests (also against the real server), and a Windows build that produces the installer.

## M0 — Foundations (2026-10-07)

**In plain words:** the invisible backbone is built and proven by 176 automatic tests. There are no screens yet; those come in M1.

- **Database safety rules:**
  - nothing can be deleted
  - nothing can be written without a known user
  - final records cannot change
  - every write is recorded in the audit diary
- **Tamper-evident audit diary:** each entry is sealed with a fingerprint chained to the previous one. A secret change made with full database access is caught at the exact entry (`pnpm demo:audit-tamper`).
- **Gapless numbering:** 13 series (`POS-`, `INV-`, `CN-`, `Q-`, `RCT-`, …). 50 simultaneous requests, some of them cancelled, still give 1, 2, 3… with no gaps or repeats.
- **Money calculator:**
  - integers only: fils, plus 4-decimal unit prices
  - VAT calculated per line
  - discounts spread exactly across lines
  - the same rounding rule in the app and in the database, proven by shared test cases
- **Safe database upgrade tool:** it refuses to run an upgrade file that was edited after use.
- **Users, roles and permissions:**
  - 5 default roles
  - 64 permissions, 11 of which a supervisor can approve once
  - the agreed role matrix
- **Settings:** 22 settings with the agreed defaults (oversell with approval, silent POS receipts, "Copy" on reprints, e-invoicing date pending).
- **Server core:** one transaction per business operation with automatic retry after a deadlock, strict time limits, no secrets in logs, and a `/health` check.
- **Tooling:** CI on GitHub runs everything on PostgreSQL 18. A step-by-step Windows setup guide is included.
