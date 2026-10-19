# 0095 — Google Drive: connect by choosing the account; one registration for the app

| | |
|---|---|
| **Status** | Accepted (2026-10-19) |
| **Date** | 2026-10-19 |
| **Decided by** | Owner |
| **Related** | [0086](0086-backups-local-and-google-drive.md) (updated) |

## Decision
- **Connecting Google Drive is one button:** Settings → Backup → **Connect Google Drive → Choose account**. The PC's browser opens Google's page, the owner chooses the shop's Google account (the one for backups) and presses Allow; the app shows "Google Drive is connected". Nobody types a client ID, a secret or a code.
- **The app's registration at Google ("ARTEPOOL ERP") is one, built into every installation** by the installer. It is the app's identity at Google, not anyone's account: each shop that installs the system chooses **its own** Google account, and its copies go to **its own** Drive. The registration never gives access to any shop's Drive or data.
- **Fallback:** a small "Connect with a code instead" link shows a short code to type at google.com/device on any phone or PC (same built-in registration). It is also the way in a browser during development.
- Unchanged from 0086: only the app's own files (`drive.file`); copies encrypted before upload; the refresh token sealed with the master key on the server, never in the database or a log.

## Why
The owner may install the system for other shops or companies later: connecting must not depend on anything of the owner's own, and must be as simple as any "Sign in with Google".

## How it works
- Google's recommended flow for desktop apps: authorization code + **PKCE** + a **loopback** address. The Windows app opens a one-time listener on `127.0.0.1` (this PC only, 5 minutes, one answer), opens Google's page in the PC's browser (only `https://accounts.google.com/o/oauth2/v2/auth` may be opened), receives Google's one-time code and passes it to the server over TLS. The server checks the `state`, exchanges the code with its own PKCE verifier (which never leaves the server) and seals the refresh token.
- The registration (a "Desktop app" client and a "TVs and limited input" client for the fallback) is set by the installer in the server's configuration (`ARTEPOOL_GOOGLE_CLIENT_ID` / `_SECRET`, `ARTEPOOL_GOOGLE_DEVICE_CLIENT_ID` / `_SECRET`). Google treats these values as not secret for desktop apps. Without them the screen says the installation has no Google registration.
- The registration is created once by the software publisher (runbook [backup-and-restore.md](../runbooks/backup-and-restore.md), "For the software publisher"). When many shops use it, Google may ask to verify the app's name and logo (free).

## Note on scope
The owner may offer the system to other shops or companies later. The PRD still says internal use for ARTÉPOOL with no licensing; selling or installing it elsewhere (branding per company, updates, support, licensing) would be a separate decision. This decision only makes the Google connection ready for it; nothing else changes now.
