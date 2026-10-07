# M1 — Security core and app shell: task plan

| | |
|---|---|
| **Status** | **Done — in review** (2026-10-07). Approved with the owner's answers recorded as decisions [0021](../decisions/0021-cashier-pin-sign-in-on-pos-pcs.md)–[0026](../decisions/0026-users-and-devices-never-deleted.md). Delivered on branch `m1-security-shell` (see [Delivered](#delivered)). |
| **Date** | 2026-10-07 |
| **Milestone** | M1 of the [Phase 1 plan](../phase-1-plan.md) |
| **Design reference** | [`design/screens/01-login.html`](../../design/screens/01-login.html), [`design/screens/13-settings.html`](../../design/screens/13-settings.html), tokens and components in [`design/`](../../design/) |
| **Where it runs** | Server, database and the React screens are built and tested in this cloud environment (Chromium + Playwright). The desktop shell (Tauri/Rust) is compiled and smoke-tested here on Linux, and built into the Windows installer by GitHub Actions on a Windows machine. The owner runs and tests the desktop app on their own Windows PC. |

## Goal (in plain words)

After M1:

- Only PCs that you have enrolled can talk to the server, over an encrypted connection.
- People sign in with a password, or a PIN for cashiers. The owner also enters a code from their phone.
- Wrong passwords lock the account, and idle screens lock themselves.
- The server checks a permission on every request.
- You can manage users, roles, devices and read the audit log from Settings, in Arabic and English, light and dark, matching the approved design.

There are still no sales, stock or accounting features in M1.

## How the work is delivered

- **Branch:** `m1-security-shell`, one commit per task. Tests run after every task.
- **Pull request:** one pull request into `main` at the end, with screenshots (Arabic/English, light/dark) next to the design. CI must be green.
- **Decisions:** your answers to the questions below are recorded as decisions 0021+ in `docs/decisions/`.

## Tasks

| # | Task | Main files | Tests |
|---|---|---|---|
| T1 | **Migration 0005 — devices, sessions, approvals, idempotency:**<br>• `auth.devices` (pending → active → revoked; revoked is final; reason required)<br>• `auth.sessions` (token hash only; idle, lock and absolute expiry; end reason)<br>• `auth.approvals` (single-use, expires, approver ≠ requester)<br>• `sys.idempotency_keys`<br>• `auth.users` gains a sign-in method and deactivation date/by/reason (reason required)<br>• guards: exactly one active owner; the owner cannot be deactivated or lose a permission<br>• new security settings (PIN failures, enrollment code minutes, password length, client minimum version) | `db/migrations/0005_auth_devices.sql`, `db/tests/auth-devices.test.ts`, `db/tests/privileges.test.ts` | Every CHECK and guard; a revoked device can never become active; an approval is consumed once and never after it expires; no deletes; audited (sessions and idempotency keys are technical tables and are not row-audited, as in the schema) |
| T2 | **Security building blocks:**<br>• Argon2id for passwords and PINs<br>• AES-256-GCM secret box for the owner's 2-step secret (master key from a protected file in development; Windows DPAPI is wired by the installer in M6)<br>• random 256-bit tokens, stored only as SHA-256<br>• TOTP with replay blocking<br>• password and PIN rules | `apps/server/src/platform/{crypto,auth}/*` | Unit tests: wrong key or edited ciphertext → refused; the same TOTP code twice → refused; weak PINs refused |
| T3 | **Request pipeline:**<br>• device check on every request (except health and enrollment)<br>• session check with idle lock<br>• **route permission guard**: a route without a declared permission makes the server refuse to start<br>• idempotency keys on every save<br>• rate limits on sign-in and enrollment<br>• log redaction (passwords, PINs, codes, tokens, device keys) | `apps/server/src/platform/{permissions,idempotency}/*`, `apps/server/src/app.ts` | Every route declares a permission (enumerated automatically); a missing permission → 403 and an audit event; a replayed save → the same answer; a changed body with the same key → 409; **no secret appears in the logs** of a full sign-in and enrollment run |
| T4 | **Sign-in API:**<br>• password; lockout after 5 failures for 15 minutes (settings)<br>• owner 2-step code, setup with QR, recovery codes<br>• PIN sign-in and user switch<br>• new password or PIN at first sign-in<br>• idle lock and unlock<br>• sign out<br>• audit events for each of these | `apps/server/src/modules/auth/*` | Lockout and unlock; locked account refused even with the right password; owner without the code → refused; TOTP replay → refused; session expiry (12 h) and idle lock (5 / 15 min); a password change ends the user's other sessions; same answer for unknown user and wrong password (no username guessing) |
| T5 | **Devices API + first-time setup commands:**<br>• one-time enrollment code (shown once)<br>• enrollment proves the server is genuine (see question 4)<br>• device key renewal<br>• rename / set type<br>• revoke with a reason, which ends that PC's sessions immediately<br>• server commands `pnpm owner:create` and `pnpm device:code` for the very first owner and PC | `apps/server/src/modules/system/devices/*`, `tools/bootstrap/*` | Code works once only; expired code → refused; guessing is rate-limited; a revoked PC's next request → refused; "this device" and the server cannot be revoked from the screen |
| T6 | **Users, roles, approvals and audit API:**<br>• users: list, create with a one-time temporary code, reset password/PIN, unlock, deactivate with a reason, reactivate<br>• roles: create by copying, edit permissions and discount limits (owner role and owner-only permissions locked)<br>• approvals: supervisor PIN + reason, single use, 5 minutes, a different person who holds the permission<br>• audit: list with filters, detail with before/after, verify now, export to CSV (logged) | `apps/server/src/modules/{users,audit}/*`, `apps/server/src/platform/permissions/approvals.ts`, `packages/shared/src/contracts/*` | Self-approval, expired and reused approvals → refused; approver without the permission → refused; every write → audit entry with old/new values; the API database role cannot delete or alter the audit log |
| T7 | **HTTPS with the private ARTÉPOOL CA:**<br>• `pnpm tls:init` creates the CA with name constraints and the server certificate<br>• the server listens on HTTPS with **TLS 1.3 only**<br>• development certificates kept out of Git | `tools/tls/*`, `apps/server/src/main.ts` | A TLS 1.2 client is refused; the CA can only sign the ARTÉPOOL server's names; the private key never enters the repository |
| T8 | **Desktop app foundation:**<br>• Vite + React 19, TanStack Router/Query, React Aria, i18next<br>• design tokens and component styles taken from `design/` (a test keeps them identical)<br>• IBM Plex Sans Arabic and Lucide icons bundled locally<br>• lint rules: no literal UI text, no raw colours, logical CSS only | `apps/desktop/src/{app,ui,theme,i18n,api}/*`, `stylelint.config.js`, `eslint.config.js` | Component tests in Arabic and English; lint fails on a hard-coded colour, a `margin-left`, or text outside i18n |
| T9 | **Sign-in screens (design 01):**<br>• password, PIN, owner code, wrong password, account locked, server unreachable with "Try again"<br>• plus screens the design does not show, built in the same style: first sign-in (new password/PIN), owner 2-step setup (QR + recovery codes), enroll this PC (server address + code), idle lock screen | `apps/desktop/src/features/auth/*` | Playwright flows in **ar + en, light + dark** against the real server and a test database; the language switch mirrors the layout; server stopped → unreachable screen → retry |
| T10 | **App shell + Settings (design 13):**<br>• sidebar, top bar, language and theme switches, user menu (lock, switch user, sign out)<br>• Settings: Users & permissions, Devices, Audit log<br>• Company, VAT & numbering, Backup, Print designer and printers are shown greyed "coming later" (their milestones: M2, M2, M6, M4/M5) | `apps/desktop/src/app/*`, `apps/desktop/src/features/{admin,audit}/*` | Playwright: create a user → temporary code shown once; deactivate with a reason; revoke a PC with a reason; each one appears in the audit log with before/after; a non-owner never sees Settings and the server refuses them anyway |
| T11 | **Windows desktop shell (Tauri 2, Rust):**<br>• all server calls go through Rust: TLS 1.3, trusting **only** the ARTÉPOOL CA<br>• device key kept in Windows Credential Manager, never visible to the screen code<br>• single instance<br>• update check that requires a valid signature (the signing key itself is created with you in M6)<br>• `pnpm dev:desktop` | `apps/desktop/src-tauri/*` | Rust unit tests for the connection rules; Windows build in CI |
| T12 | **CI and docs:**<br>• CI: desktop tests, Playwright, and a Windows build job<br>• Windows guide: Rust + C++ Build Tools, `pnpm dev:desktop`, enrolling your PC<br>• `CLAUDE.md` commands, decisions 0021+, changelog<br>• pull request with screenshots | `.github/workflows/ci.yml`, `docs/*` | Green CI |
| T13 | **Easier owner sign-in** (asked by the owner after trying M1; decisions [0027](../decisions/0027-trust-this-pc-for-the-2-step-code.md), [0028](../decisions/0028-forgot-password-with-phone-and-recovery-code.md)):<br>• "Trust this PC for 30 days" under the phone code (never on POS PCs); Settings → Devices shows who is trusted until when and can end it<br>• "Forgot your password?" with the phone code and one recovery code | `db/migrations/0006_device_trust.sql`, `apps/server/src/modules/{auth,devices}/*`, `apps/desktop/src/features/auth/RecoverPasswordScreen.tsx` | Database rules (only the person, on that PC; never POS; ends by itself); API (trust offered/used/ended, recovery success, one answer for any wrong part, weak password wastes no code, works while locked, replay refused, no secret in logs); screens; Playwright in both languages |

## Differences from the approved design (to keep the design honest)

1. **Permissions list:** the design shows 9 sample permissions. The real screen lists all the system's permissions (64), grouped by module, in the same style.
2. **Four extra screens** that the design does not include are built in the same style as the sign-in screen: first sign-in, owner 2-step setup, enroll this PC, and the idle lock screen.
3. **"Certificate until"** on the devices table becomes "Key valid until": each PC has a secret key that renews itself automatically before it expires.
4. **Sample numbers in the design** (for example "3 failed sign-ins → locked") follow the real settings (5 failures, 15 minutes).
5. **PIN option on the sign-in screen:** shown on POS PCs only (decision 0021); office PCs show the password form alone.
6. **Owner role permissions:** instead of 64 locked switches, the owner role shows one line: it always has every permission.
7. **Top bar:** the account chip shows the person's name and username, and opens a small menu (Lock screen, Sign out).
8. **Settings sections not built yet** (Company, VAT & numbering, Print designer, Backup) are greyed with "Soon".
9. **App icon:** a placeholder in the brand colour until the final logo is supplied.
10. **Two more screens and one box** that the design does not show, in the same style (T13): "Choose a new password" (forgot password), "Your password was changed", and the "Trust this PC" box under the phone code.

## Questions for the owner (answered 2026-10-07)

| # | Question | Answer (all recommendations accepted) |
|---|---|---|
| 1 | **Cashier sign-in.** The design lets cashiers sign in with a PIN only. The PRD says a PIN is for switching users and approvals. Which one? | PIN sign-in **only on PCs enrolled as POS**, 4 digits, easy PINs (1234, 0000, 1111…) refused, PIN blocked after 5 wrong tries until the owner unlocks it. Office PCs always need a password. → [0021](../decisions/0021-cashier-pin-sign-in-on-pos-pcs.md) |
| 2 | **Owner's phone lost.** How does the owner get back in? | 10 one-time recovery codes, shown once at setup, printed and kept in the safe. Plus an emergency reset command that only works on the server PC itself and is written to the audit log. → [0022](../decisions/0022-owner-2-step-recovery.md) |
| 3 | **Password rules.** | At least 10 characters, no forced symbols, common passwords refused, no forced expiry. A changed password ends the user's other sessions. → [0023](../decisions/0023-password-rules.md) |
| 4 | **How a new PC trusts the server.** | The one-time enrollment code also proves the server is genuine, so nothing needs copying by hand. (Alternative: copy a certificate file to each PC with a USB stick.) → [0024](../decisions/0024-device-enrollment-proves-the-server.md) |
| 5 | **Enrollment code lifetime.** The design says 10 minutes; the architecture says 15. | 10 minutes, as in the design. → [0024](../decisions/0024-device-enrollment-proves-the-server.md) |
| 6 | **The very first owner and PC.** There is no one to sign in yet. | Created once by commands run on the server PC (`pnpm owner:create`, `pnpm device:code`), in production by the installer in M6. → [0025](../decisions/0025-first-owner-and-pc-from-server-commands.md) |

Also confirmed by the owner: nothing is ever deleted; users are deactivated and devices revoked, always with a reason → [0026](../decisions/0026-users-and-devices-never-deleted.md).

## Done when

- All tests pass here and in CI, including the Windows build.
- You can follow the updated Windows guide to enroll your PC, sign in, lock the account with 5 wrong passwords, switch language and theme, see "server unreachable" when the server stops, and manage users and devices with every change visible in the audit log.

## Delivered

| Task | Commit(s) | Result |
|---|---|---|
| T1 | `abb647e` | Migration 0005 and its database tests |
| T2 | `174acea` | Argon2id, secret box, tokens, TOTP, password and PIN rules |
| T3 | `1cb6dfb` | Device, session and permission checks on every route; idempotency; rate limits; log redaction |
| T4 | `a69d914`, `1686c7e` | Sign-in API (password, PIN, owner 2-step, recovery codes, first-sign-in change, lock, sign out) |
| T5 | `4502aab` | Enrollment protocol v1, devices API, `pnpm owner:create` / `device:code` / `owner:reset-2fa` |
| T6 | `5f5e85a` | Users, roles, approvals, audit API |
| T7 | `0ec68fc` | `pnpm tls:init`; HTTPS with TLS 1.3 only |
| T8 | `ba02bab` | Desktop app foundation; lint rules for UI text, colours and logical CSS |
| T9 | `161f997`, `cd15773`, `d4b8fe3` | Development bridge; sign-in screens; Playwright flows |
| T10 | `c10369f` | App shell and Settings (users, roles, PCs, audit log) |
| T11 | `ede591a` | Windows app (Tauri) with the Rust bridge |
| T12 | `b501a6b`, `666d79b` | CI jobs (screens, Rust, Windows), Windows guide, docs |
| T13 | `5ea768a`, `b2ec002`, this commit | Trusted PCs for the 2-step code (migration 0006) and forgot password, with screens and tests |

**Tests at the end of M1:** 163 unit and screen-component tests, 256 integration tests (real PostgreSQL), 26 Rust tests, 32 Playwright flows (16 in Arabic/light, 16 in English/dark).

**Open items:**
- **Accountant and Settings** (asked, not blocking): with the current role matrix the accountant can view the audit log (so they see Settings → Audit log only) and has `system.company.edit`. Recommendation: keep audit-log viewing, make company details owner-only. Applied as role data when the owner answers.
- **Update signing key and installer checksums:** created with the owner in M6 (until then no update can be installed).
- **Final logo:** replaces the placeholder icon when supplied.
- **Password command on the server PC** (asked, not blocking): if the phone, the recovery codes **and** the password are all lost, the app cannot recover the owner account. A server-PC `pnpm owner:reset-password` (reason required, audited) would close that gap.
- **Migration numbers:** 0006 is now "trusted PCs", so the chart of accounts is 0007 and master data 0008. The comments inside 0005 still say "0007" for master data; they cannot be edited (applied migration).
