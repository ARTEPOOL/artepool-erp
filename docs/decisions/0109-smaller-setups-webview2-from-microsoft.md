# 0109 — Smaller setups: WebView2 from Microsoft when missing, instead of inside every setup

| | |
|---|---|
| **Status** | Deferred (2026-10-25): the owner wants it kept in mind, not done now |
| **Date** | 2026-10-25 |
| **Decided by** | Owner |
| **Related** | [0103](0103-upgrades-and-uninstall-never-touch-data.md) setups work without internet; [0108](0108-automatic-online-updates.md) online updates; [0106](0106-every-windows-edition.md) Windows editions |

> **Deferred:** the setups keep the offline WebView2 installer for now. This is the plan for when the download size matters.

## Proposal
- The setups are large (about 290 MB for `ARTEPOOL-Server-Setup`, about 220 MB for `ARTEPOOL-Office-Setup`). The biggest part of each is Microsoft's offline WebView2 installer (about 180 MB), which most PCs already have: Windows 11 ships it, and Windows 10 gets it with Edge's updates.
- Change the desktop app's `webviewInstallMode` from `offlineInstaller` to Microsoft's bootstrapper: when WebView2 is already installed nothing is downloaded; when it is missing, it is downloaded from Microsoft during the setup.
- Expected sizes: Office setup about 40 MB, server setup about 110 MB; updates shrink the same way.
- PostgreSQL, Node and everything else the server needs stay inside the server setup, so a dropped connection never breaks the installation of the database.

## What does not change
- The program works without internet in the shop exactly as before. Internet is needed only for the setup (when WebView2 is missing), updates and the Google Drive copy.

## Trade-off
- A PC with no internet at all and no WebView2 (an old Windows 10 never updated) could not be set up. A full offline setup could be kept for support only.

## When taken up
- Accept this decision (it changes 0103's "setups work without internet" for WebView2 only), switch the install mode, check on the Windows CI and the clean VMs (Windows 10 Home without WebView2 included) that a missing WebView2 is fetched and an existing one is used.
- Related later idea: updates that download only what changed (the program, not PostgreSQL or Node again).
