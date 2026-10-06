# 0002 — Separate private repository

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner |

## Decision
- The ERP lives in its own **private** GitHub repository, `artepool-erp`.
- Nothing for the ERP is built inside the Adreta website repository.
- `PRD.md` and `CLAUDE.md` were moved into this repository.

## Why
- The ERP holds business-critical code and must not be mixed with an unrelated website.
- Access, CI and reviews stay separate.

## Consequences
- The planning drafts first written on a branch of the website repository were removed from there. Their final versions live here.
- Future work uses branches and pull requests in this repository.
