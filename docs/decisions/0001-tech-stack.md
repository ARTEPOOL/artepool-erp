# 0001 — Tech stack

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-06 |
| **Decided by** | Owner |

## Decision
The stack proposed in the architecture review is confirmed:

- **Database:** PostgreSQL 18 (≥ 16 compatible) on the Main Server PC. It listens on localhost only.
- **API:** Node.js 24 LTS + TypeScript (strict), Fastify 5, Kysely on node-postgres, Zod contracts. It runs as a Windows service (WinSW).
- **Desktop client:** Tauri 2 + React 19 + TypeScript (Vite, TanStack Query/Router, React Aria Components, CSS Modules + design tokens, i18next).
- **Transport:** HTTPS with TLS 1.3 only and a private ARTÉPOOL certificate authority. Only enrolled devices can connect.
- **Migrations:** numbered plain-SQL files, run by our own runner with checksums.
- **Tests:** Vitest (unit + integration on real PostgreSQL), fast-check, Playwright.
- **Tooling:** pnpm workspaces, GitHub Actions.

## Why
- PostgreSQL gives strong transactions, row locking, point-in-time recovery and least-privilege roles, all for free.
- One language (TypeScript) is used for the server and the UI. Plain SQL gives exact control over locking and constraints.
- Tauri is small and harder to tamper with than Electron.

**Rejected alternatives:**
- an ORM (Prisma/TypeORM): poor fit for row locks and deferred constraints
- Electron
- Tailwind: makes it too easy to hard-code styles
- JWT sessions: cannot be revoked instantly

## Consequences
- The full stack table is in `CLAUDE.md` and `docs/architecture.md`.
- The planned commands are in `CLAUDE.md`. They become real in milestone M0.
