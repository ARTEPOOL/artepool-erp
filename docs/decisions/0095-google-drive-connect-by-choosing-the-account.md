# 0095 — Google Drive: connect by choosing the account; one registration for the app

| | |
|---|---|
| **Status** | Accepted (2026-10-19) |
| **Date** | 2026-10-19 |
| **Decided by** | Owner |
| **Related** | [0086](0086-backups-local-and-google-drive.md) (updated) |
| **Updated** | 2026-11-02: the registration published "In production", its public pages, how releases carry it, and the alert when Google refuses the saved access (0.9.1) |

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

## Update (2026-11-02, 0.9.1): the registration in practice, and the alert

Approved by the owner on 2026-11-02.

**The registration (done once by the publisher, [google-registration.md](../runbooks/google-registration.md)):**
- Project `ARTEPOOL ERP`, the Google Drive API, an **External** consent screen with the `drive.file` scope only and no logo.
- **Published "In production".** In "Testing", Google ends every connection 7 days after the consent, and the off-site copies would stop.
- Google requires a home page, a privacy policy and terms on a domain the publisher owns, for an external production app. They are at <https://artepool.github.io/> (GitHub Pages, the `ARTEPOOL/artepool.github.io` repository; source in `docs/google-site/`). The domain is verified in Google Search Console, and the contact address is the software's Google account.
- `drive.file` is a non-sensitive scope: no security review, no "unverified app" screen, no 100-user cap. Brand verification (the name on the consent screen; free) is done only if Google asks: a verified domain, a public home page and a privacy policy.

**The four values never go in the repository or a chat:**
- They live only as secrets of the protected GitHub `release` environment: `ARTEPOOL_GOOGLE_CLIENT_ID`, `ARTEPOOL_GOOGLE_CLIENT_SECRET`, `ARTEPOOL_GOOGLE_DEVICE_CLIENT_ID`, `ARTEPOOL_GOOGLE_DEVICE_CLIENT_SECRET`.
- The release workflow passes them to the build, which checks and trims them; half a client stops the release. The build writes `google.json` into both server setups, and the release summary says what it carries (never the values).
- The installed server reads `C:\Program Files\ARTEPOOL\google.json` at every start. It wins over the copy the settings file got at the first install, so a server installed before the registration existed gets it with its next update.

**When Google refuses the saved access:**
- Google's answer is recorded at every off-site upload. Between uploads, a check runs every 6 hours (a token request only, nothing uploaded) and right after the owner connects again.
- **Access ended** (`invalid_grant`): the registration was left in Testing, the access was removed from the Google account, or the account is gone. System health shows it in red, a daily alert is raised (`backup_failed`, which `drive_access`), and the backup screen offers **"Connect Google Drive again"**.
- **Registration refused** (`invalid_client`, `unauthorized_client`, `deleted_client`, `disabled_client`): the publisher makes a new client and puts it in the secrets; the next update brings it. The alert's which is `google_registration`.
- A network failure is neither: it shows as a late off-site copy, as before.
- Connecting again clears the warning, because an answer older than the saved access does not count.
- The answer is kept in `.drive-access` in the backups folder, like the heartbeat: Google's error code only, never a token. No database change.
