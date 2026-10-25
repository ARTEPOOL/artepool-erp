# 0108 — Automatic online updates through a public releases repository, signed by GitHub after the owner's approval

| | |
|---|---|
| **Status** | Accepted (2026-10-25) |
| **Date** | 2026-10-25 |
| **Decided by** | Owner |
| **Related** | Replaces the "updates without internet" part of [0103](0103-upgrades-and-uninstall-never-touch-data.md) (its upgrade, uninstall and delete-data rules stay); extends [0007](0007-no-code-signing-certificate-for-now.md); [0086](0086-backups-local-and-google-drive.md) backups; [0093](0093-no-remote-access-in-phase-1.md) unchanged (updates are outgoing only, nothing reaches into the shop) |

## Decision

Updates are automatic and online, with no manual step for the owner except one click to approve each release.

**Where updates come from**
- The source code stays in the **private** repository.
- A separate **public** repository, `adretaae-ctrl/artepool-releases`, holds **only** the signed installers, their signatures, the update list (`latest.json`, with release notes in Arabic and English) and `SHA256SUMS.txt`. No source code, no secrets, no shop data, no internal documents. A check in the release workflow refuses to publish any other kind of file.
- Shop PCs read that public list over HTTPS; they need no password or token.

**How a release is made and signed**
1. Code changes are pushed to the private repository.
2. GitHub Actions builds the release in a protected **`release` environment** that waits for the **owner's approval** (one click) before it runs.
3. The release is signed there with the update key. The private key and its password are secrets of that environment only. Signing stays mandatory.
4. The workflow publishes the files to `artepool-releases` with a fine-grained token limited to that one repository (also a secret of the `release` environment).
5. The owner turns on 2-step sign-in for the GitHub account (reminded in the guide).

**How the shop installs an update**
- **The server PC first.** It checks for a new version by itself, downloads it in the background, checks its signature and SHA-256, and installs it **only at a safe time**:
  - no shift is open (so never during a sale);
  - after an automatic backup that was checked;
  - at night by default, or at once when the owner presses **Install now** (System health).
- The installation follows 0103: the data is kept, a pre-upgrade backup, database changes all-or-nothing, and on any failure the previous version is put back and started.
- **Then the other PCs** (office laptop, a second POS): the app updates itself from the internet, or from the server PC when the internet is not reachable from that PC; same signature check.
- **No internet:** everything keeps working; updates wait until the internet is back.
- **System health** shows the current version, an available update with its release notes (Arabic and English), the result of the last update, and **Install now** (owner only).
- **USB update** stays as a fallback for support only: running the newer server installer on the server PC performs the same safe upgrade. It is not shown to the shop.

## Why
The owner wants updates without manual work. Keeping the code private while publishing only signed installers lets the PCs update without any password built into the app; the signature means a fake installer is refused even though the files are public; the owner's approval on each release and 2-step on GitHub protect the signing key.

## Consequences
- The update key is online (a GitHub secret), not offline as 0103 said. It is protected by the `release` environment (owner approval, `main` only) and by the GitHub account's 2-step sign-in. If the key is ever leaked, a new key is made and the next release must be installed once by hand (USB fallback).
- New pieces: the release workflow with the publish check; a privileged updater on the server PC (runs as SYSTEM, verifies before running anything, refuses older versions); update state and "Install now" in System health; the app's updater pointed at the public list and the server PC.
- The server PC needs outgoing HTTPS to `github.com` and its download hosts. Nothing incoming; 0093 is unchanged.
- One-time steps for the owner, in `docs/runbooks/updates-setup.md` (Arabic): turn on GitHub 2-step, create the empty public repository, create the `release` environment with the owner as the required reviewer, create the update key and the publish token, and save them as environment secrets.
