# 0112 — A new version is released by merging it, with the owner's one approval

| | |
|---|---|
| **Status** | Accepted (2026-10-29) |
| **Date** | 2026-10-29 |
| **Decided by** | Owner |
| **Related** | [0108](0108-automatic-online-updates.md) automatic online updates; [0110](0110-check-for-updates-now.md) "Check now" |

## Decision

- **Merging the pull request that raises the app's version** (`apps/desktop/package.json`) starts the release. Nobody types git commands, and the owner pushes no tag.
- **The owner's approval stays.** The release still waits in the protected `release` environment for the owner's one click. Only then do the signing key and the publishing token exist for the job (0108).
- **Nothing is released twice.** A merge that keeps the version releases nothing. A version already published in `ARTEPOOL/artepool-releases` releases nothing either; the public repository is read with the job's own read-only token.
- **After the release,** the workflow adds the version tag (`v1.2.3`) to this repository for the history.
- **A refused or failed release** can be started again from GitHub: Actions → Release → **Run workflow** on `main`.
- **One-time setting:** the `release` environment must allow the `main` branch (Settings → Environments → release → Deployment branches and tags → add the branch `main`). It used to allow only `v*` tags.

## Why

After every release, the owner asked why they still had to type git commands when the shop's PCs update by themselves. Those commands were only there to publish. The approval click is the safeguard that matters: no version reaches the shop unless the owner approves it, even if someone gets into the GitHub account.
