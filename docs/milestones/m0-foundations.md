# M0 — Foundations: task plan

| | |
|---|---|
| **Status** | **Done** (2026-10-07). Approved 2026-10-07, including both adjustments. Delivered on branch `m0-foundations`. |
| **Date** | 2026-10-07 |
| **Milestone** | M0 of the [Phase 1 plan](../phase-1-plan.md) |
| **Where it runs** | This cloud environment (Linux) and GitHub Actions CI. From M1 onwards, development moves to the owner's Windows PC. |

## Goal (in plain words)

Build the invisible backbone that everything else stands on, with automatic tests proving it works:

- the project skeleton and its quality checks
- the database's safety rules: no deletions, no writes without a known user, gapless numbering
- the tamper-evident audit diary
- the shared money calculator
- the tool that upgrades the database safely

There are no screens and no business features in M0. At the end you get simple step-by-step instructions to set the project up on your Windows PC.

## How the work is delivered

- **Branch:** all M0 work happens on `m0-foundations`, one commit per task below.
- **Pull request:** at the end I open a pull request into `main`, with a plain-language summary and the test results. You merge it with one click on GitHub.
- **Then:** you clone `main` on your Windows PC using the instructions I give you.
- **CI gate:** CI (GitHub Actions) must be green before the pull request is ready.

## Tasks

| # | Task | Main files | Tests |
|---|---|---|---|
| T1 | **Workspace scaffold:** pnpm workspace, TypeScript strict, ESLint + Prettier, EditorConfig, `.gitattributes` (LF endings so Windows and Linux agree), `.nvmrc` (Node 24), `.env.example` | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `.editorconfig`, `.gitattributes`, `.gitignore`, `.nvmrc`, `.env.example` | `pnpm check` runs clean |
| T2 | **Shared money module**, using `bigint` only and never floats:<br>• `roundDiv` (half away from zero)<br>• 4-dp → fils<br>• line amount (quantity × 4-dp price)<br>• VAT exclusive / inclusive per line<br>• discount allocation (largest remainder)<br>• parse / format of amounts and quantities as strings | `packages/shared/src/money/*` | Unit tests; property tests (fast-check: allocations always add up, net + VAT = gross, symmetry for negatives); **shared test vectors** `db/test-vectors/rounding.json` |
| T3 | **i18n package skeleton:** `ar` / `en` locale files and the key-parity check | `packages/i18n/locales/{ar,en}/common.json`, `packages/i18n/check-keys.ts` | CI fails if a key exists in one language only |
| T4 | **Migration runner:**<br>• applies `db/migrations/NNNN_name.sql` in order, each in one transaction<br>• records a SHA-256 checksum and **refuses to run if an applied file was edited**<br>• rejects numbering gaps or duplicates<br>• an advisory lock prevents two runs at once<br>• commands: `status`, `new <name>`, dry run | `tools/migrate/src/*` | Applies in order; edited file → refused; failed migration → fully rolled back; concurrent run → blocked |
| T5 | **Dev database setup:** `pnpm db:setup` creates the roles (`artepool_owner`, `artepool_migrator`, `artepool_api`, `artepool_backup`, `artepool_maint`) and the `artepool_dev` / `artepool_test` databases from `.env`. **Dev only:** it refuses database names that don't end in `_dev` or `_test`. The production installer comes in M6. | `tools/dev-db/*` | Running it twice is safe (idempotent) |
| T6 | **Migration 0001 — extensions, schemas, helpers:**<br>• `pg_trgm`, `btree_gist`, the 9 schemas<br>• `sys.normalize_search` (Arabic variants)<br>• `sys.business_date` (Asia/Dubai)<br>• `sys.round_div`<br>• `sys.set_context` + context getters<br>• `sys.touch_row`<br>• the generic guards (no-delete, immutable columns, draft lines)<br>• schema grants | `db/migrations/0001_extensions_schemas_helpers.sql` | Search normalization cases (أ/ا, ة/ه, ى/ي, tashkeel, Arabic digits); `round_div` passes the **same vectors** as T2; 20:30 UTC = next day in Dubai |
| T7 | **Migration 0002 — audit log and hash chain:**<br>• `audit.log`, `chain_head`, `anchors`, `verifications`<br>• `capture_row` (redaction, ignored columns, **rejects writes without context**)<br>• `enable_for`, `record_event`<br>• `seal_transaction` (deferred, at commit)<br>• `verify_chain`, `add_anchor`<br>• update, delete and truncate blocked | `db/migrations/0002_audit.sql` | Rows sealed at commit with consecutive numbers; a rolled-back transaction leaves no trace and no gap; 10 parallel transactions → chain verifies; a row edited as superuser → detected at the exact entry; the API role cannot write the log directly; secrets redacted |
| T8 | **Migration 0003 — users, roles, permissions:**<br>• `auth.users` with the SYSTEM user<br>• `roles` (5 defaults)<br>• `permissions` (full list from schema §15.1)<br>• `role_permissions` (default matrix), `user_roles`<br>• audit + guards on all of them<br>(Login logic comes in M1.) | `db/migrations/0003_auth_core.sql` | Every check constraint; deleting a user → refused; deleting a role permission → allowed and audited; username rules |
| T9 | **Migration 0004 — company, settings, numbering:**<br>• `company_profile` (empty: it is filled by the setup screen in M2)<br>• `settings` (defaults from schema §15.4)<br>• `branches` (HQ)<br>• `document_series` (all 13 series: `POS-`, `INV-`, `CN-` …) + `sys.next_number`<br>• `alerts`, `import_batches` | `db/migrations/0004_sys_core.sql` | **50 parallel number requests with random rollbacks → committed numbers are exactly 1…N, with no gaps and no repeats**; the counter cannot be changed except by +1; the API role cannot update it directly |
| T10 | **Server platform core:**<br>• typed config<br>• PostgreSQL pool (BIGINT read as `bigint`, NUMERIC as exact strings)<br>• Kysely + generated table types<br>• **`withBusinessTx`**: one transaction, request context, timeouts, one automatic retry on deadlock<br>• error codes<br>• a `GET /health` route only: database reachable, migrations up to date, audit chain head | `apps/server/src/platform/{config,db,errors,time}/*`, `apps/server/src/main.ts` | All-or-nothing: an error inside the operation rolls back its data **and** its audit rows; context appears in the audit rows; deadlock → retried once |
| T11 | **Audit tools:**<br>• `pnpm audit:verify` prints "OK" or the first broken entry in plain words<br>• `pnpm demo:audit-tamper` makes a throwaway copy of the test database, alters one record behind the system's back, and shows the verifier catching it, so you can see it with your own eyes | `tools/audit-verify/*` | Exit codes; the demo never touches the dev database |
| T12 | **Test harness:** Vitest workspaces. A fresh database per test file, cloned from a migrated template (fast). Helpers to connect as the API role or as an administrator. Shared vectors loader. | `vitest.workspace.ts`, `packages/testing/*` | — |
| T13 | **CI:** GitHub Actions on Ubuntu with Node 24 and a PostgreSQL 18 service. Steps: install → lint/typecheck/i18n → unit tests → migrate a fresh database → check generated types are current → integration and concurrency tests → audit verify | `.github/workflows/ci.yml` | Green on the pull request |
| T14 | **Docs:**<br>• README developer quick start<br>• `CLAUDE.md` "Commands" updated to what really exists<br>• **`docs/runbooks/dev-setup-windows.md`**: your step-by-step Windows setup<br>• changelog | docs | You follow the Windows guide successfully |

## Database changes in M0

**Migrations 0001–0004**, exactly as designed in [`database-schema.md`](../database-schema.md):
- §1–§2 (conventions, roles and grants)
- §4.1–4.5 and §4.8–4.9 (`sys` tables, except `reason_codes` and `idempotency_keys`, which come in M2 and M1)
- §5.1–5.5 (`auth` core)
- §6 (`audit`)

No business data is created except the reference seeds listed above.

## Two small adjustments to the approved plan

1. **The UI lint rules move from M0 to M1.** These are the rules for no literal text, no raw colors and logical CSS only. They check the desktop app, which is created in M1 on your Windows PC, so there is nothing for them to check in M0. The i18n key-parity check is still added in M0.
2. **The company profile row is left empty in M0.** It is filled through the setup screen in M2, so no placeholder company details end up in the database.

## Done when

- `pnpm install`, `pnpm db:setup`, `pnpm db:migrate`, `pnpm test` and `pnpm audit:verify` all pass, here and in CI.
- `pnpm demo:audit-tamper` shows the tampered record being detected.
- The Windows setup guide is written, and the pull request is open with a plain-language summary.

## Heads-up for your Windows PC (full step-by-step comes at the end of M0)

You will need:

- **Windows 10 or 11** and about **15 GB** of free disk space.
- **Software to install** (all free):
  - Git for Windows
  - Node.js 24 LTS (pnpm comes with it via Corepack)
  - PostgreSQL 18
  - Visual Studio Code (recommended)
- **From M1, for the desktop app:** the Rust toolchain and the Microsoft C++ Build Tools. WebView2 is already part of Windows 11.
- **Rights:** administrator rights to install these. A GitHub login to download the private repository.

## Outcome

| Check | Result |
|---|---|
| Migrations 0001–0004 | Apply cleanly; checksums recorded |
| Unit tests | 76 passed (money, VAT, allocation, parsing, translations, errors, time, settings) |
| Integration tests | 100 passed (database rules, audit chain and tampering, numbering under concurrency, runner, server, audit tools) |
| `pnpm check` | Lint, formatting, typecheck (9 packages), translations: clean |
| `pnpm audit:verify` / `pnpm demo:audit-tamper` | OK / tampering caught at the exact entry |
| Windows guide | [`docs/runbooks/dev-setup-windows.md`](../runbooks/dev-setup-windows.md) |

Notes:
- TypeScript is pinned to 6.0 because the lint tooling does not support the new TypeScript 7 compiler yet.
- Databases are created with PostgreSQL's built-in `C.UTF-8` locale, so Windows and Linux behave identically. This needs PostgreSQL 18 (the tools check the version).
