# 0088 — No cloud database in Phase 1; an outbox for a read-only mobile dashboard later

| | |
|---|---|
| **Status** | Accepted (2026-10-19) |
| **Date** | 2026-10-18 |
| **Decided by** | Owner |

## Decision
- **Phase 1:** no Supabase or any cloud database. The server PC in the shop is the only system of record.
- **Phase 2:** a read-only mobile dashboard (for example on Supabase) may be added **without changing the core**: the server writes the figures to publish into an **outbox** in the same transaction (the pattern already used for e-invoicing, 0019); a separate publisher sends them when the internet is up.
  - Only summary figures (the dashboard numbers of 0081), never customer details, costs per item or passwords, unless the owner decides otherwise then.
  - Nothing ever flows back from the cloud into the shop's database.
- The mobile dashboard's own security (sign-in, encryption) is decided in Phase 2.

## Why
Offline-first and data in the shop, while leaving a clean door for a phone dashboard.
