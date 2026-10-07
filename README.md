# ARTÉPOOL ERP

ARTÉPOOL ERP is an offline-first Windows desktop system for **ARTÉPOOL** (swimming pools, Al Ain, UAE). It covers:

- invoicing and POS
- inventory, cash drawer and shifts
- accounting
- service contracts, service jobs and construction projects

It runs client–server on the local network: PostgreSQL and an API service on a Main Server PC, and Tauri desktop clients on any number of PCs. It is bilingual Arabic/English and for internal use only.

**Status:** the Phase 1 plan is approved. Milestone M0 (foundations) is being planned; no application code exists yet.

| Start here | |
|---|---|
| [`PRD.md`](PRD.md) | Scope: what we build |
| [`CLAUDE.md`](CLAUDE.md) | Rules: how we build (golden rules, stack, commands) |
| [`docs/phase-1-plan.md`](docs/phase-1-plan.md) | Phase 1: structure, migrations, build order, test plan, plain-language summary |
| [`docs/architecture.md`](docs/architecture.md) | How the system works |
| [`docs/database-schema.md`](docs/database-schema.md) | Full Phase 1 database schema |
| [`docs/accounting/`](docs/accounting/posting-map.md) | Provisional chart of accounts and posting map (for the accountant) |
| [`docs/decisions/`](docs/decisions/README.md) | Every decision, one file each |
