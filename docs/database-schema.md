# ARTÉPOOL ERP — Phase 1 Database Schema

| | |
|---|---|
| **Status** | Approved with the Phase 1 plan (2026-10-07). This is a design document; the SQL migrations implement it milestone by milestone. |
| **Date** | 2026-10-06 |
| **Database** | PostgreSQL 18 (≥ 16 compatible, except `uuidv7()`, which the API can generate on 16/17) |
| **Related** | [`architecture.md`](architecture.md) · [`phase-1-plan.md`](phase-1-plan.md) · [`decisions/`](decisions/README.md) · [`accounting/`](accounting/chart-of-accounts.md) |

Phase 1 has **68 tables in 9 schemas**, plus reporting views and the functions and triggers that enforce the rules. Tables for later phases are listed in §17.

---

## 1. Conventions

| Topic | Convention |
|---|---|
| Schemas | `sys` (system), `auth` (security), `audit`, `md` (master data), `inv` (inventory), `sales`, `cash`, `gl` (general ledger), `ops` (operations). One schema per server module. |
| Primary keys | `id bigint GENERATED ALWAYS AS IDENTITY` |
| External IDs | Every document has `uuid uuid NOT NULL UNIQUE DEFAULT uuidv7()` (e-invoicing and outside references) |
| **Amounts** | `*_fils bigint`: integer fils, 2 decimals (1 AED = 100). All document amounts, totals, payments, journal amounts and stock **book** values. ([0014](decisions/0014-money-precision-and-rounding.md)) |
| **Unit prices / unit costs / average cost / exact stock value** | `*_4dp bigint`: integer AED × 10,000, 4 decimals (1.2345 AED = `12345`) |
| Conversion to fils | **Only** through the shared rounding helper (half away from zero). There is no cash rounding. |
| Rates | `*_bp integer`: basis points (5% = `500`, 100% = `10000`) |
| Quantities | `numeric(14,3)`: exact decimal, never float. The API does its math in integer thousandths. |
| Timestamps | `timestamptz`, server-set (`now()`; `clock_timestamp()` in the audit log), UTC |
| Business dates | `date` in Asia/Dubai via `sys.business_date()` |
| Statuses / kinds | `text` + `CHECK (… IN (…))` |
| Bilingual names | `name_ar` + `name_en`; customers and suppliers use `name` + optional `name_alt` |
| Search | `search_key text GENERATED ALWAYS AS (sys.normalize_search(…)) STORED` + GIN trigram index. Normalization: lower-case; strip tashkeel and tatweel; أ إ آ ٱ → ا; ة → ه; ى → ي; ؤ → و; ئ → ي; Arabic-Indic digits → 0-9. |
| Codes | `code text`, unique on `lower(code)`, `CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$')` |
| **[active]** | `is_active boolean NOT NULL DEFAULT true`. Master data is deactivated, never deleted. |
| **[std]** | `created_at timestamptz NOT NULL DEFAULT now()`, `created_by bigint NOT NULL → auth.users`, `updated_at timestamptz NOT NULL DEFAULT now()`, `updated_by bigint NOT NULL → auth.users`, `row_version integer NOT NULL DEFAULT 1` (optimistic locking; incremented by trigger) |
| **[ins]** | `created_at timestamptz NOT NULL DEFAULT now()`, `created_by bigint NOT NULL → auth.users` (append-only tables) |
| SYSTEM user | `auth.users` id 1 = `system` (cannot log in): seeds and scheduled jobs |
| Foreign keys | `ON DELETE RESTRICT` everywhere |
| Rule errors | Custom SQLSTATEs `AP001`–`AP0xx`. From M2: `AP011` = a business rule, `AP012` = a permission rule, each with a machine-readable `HINT` (e.g. `ACCOUNT_IN_USE`, `CREDIT_PERMISSION`) that the API passes on and the app translates |

**Notation:** `→ x.y` means a foreign key. A type followed by `?` is nullable; every other column is `NOT NULL`.

---

## 2. Database roles and privileges

| Role | Login? | Used by | Privileges |
|---|---|---|---|
| `postgres` | yes | Nobody in daily work | Password held offline by the owner |
| `artepool_owner` | no | Owns every object | — |
| `artepool_migrator` | yes (server only) | Migration runner | Member of `artepool_owner` |
| `artepool_api` | yes (server only) | API service | See below |
| `artepool_backup` | yes (server only) | Backup service | `pg_read_all_data`, `REPLICATION`, `CREATEDB` (only for the throwaway restore-test database); write `ops.backup_runs`, `ops.integrity_runs`, move `ops.backup_requests` forward; the server PC's updater keeps `ops.update_state` and moves `ops.update_requests` forward (0108) and records the server certificate in `ops.server_health` (M6.2 H); `audit.add_anchor()`, `audit.verify_chain()`; never changes business data |
| `artepool_maint` | yes (server only) | Nightly maintenance | `DELETE` only on `sys.idempotency_keys` older than 30 days (a trigger enforces both the role and the age). Sessions are never deleted ([0026](decisions/0026-users-and-devices-never-deleted.md)). |

**`artepool_api` privileges:**

- **Reads:** `USAGE` on the application schemas; `SELECT` on tables and views.
- **Writes:** `INSERT` on business tables. `UPDATE` only on listed columns of editable tables (column-level grants).
- **No `DELETE`**, except on:
  - draft lines: `sales.quotation_lines`, `sales.document_lines`, `inv.adjustment_lines`, `inv.count_lines`. A trigger requires the parent to be a draft.
  - three link tables: `auth.role_permissions`, `auth.user_roles`, `md.bundle_components`

  Every delete is still audited.
- **Never writes directly:**
  - `inv.balances`
  - `audit.log`
  - `audit.chain_head`
  - `sys.document_series.next_number`

  These are changed only by `SECURITY DEFINER` functions and triggers.
- **Functions it may call:** `sys.set_context`, `sys.next_number`, `audit.record_event`, `audit.verify_chain`, `auth.user_has_permission`, and the rule checks that its triggers call (`auth.owner_role_id`, `auth.assert_single_owner`, `auth.assert_two_step`).
- **No** `TRUNCATE`, DDL or `CREATE`.

**Connection settings:**

- `statement_timeout = 15s`
- `lock_timeout = 5s`
- `idle_in_transaction_session_timeout = 30s`
- `TimeZone = 'UTC'`

**`pg_hba.conf`:** `127.0.0.1/32` and `::1/128` only, `scram-sha-256`.

---

## 3. Schema map

```
 auth.users ◄─ auth.user_roles ─► auth.roles ◄─ auth.role_permissions ─► auth.permissions
     ▲     auth.devices (+ device_activity) · auth.enrollment_codes · auth.sessions
     │     auth.approvals (single-use supervisor approvals) · auth.recovery_codes (owner 2-step)
     │     auth.device_trust ("trust this PC" for the 2-step code, 0006)
     │     auth.kiosk_lock_changes · auth.kiosk_code_failures (POS kiosk lock, 0034)
     │
 sys.company_profile · sys.settings · sys.branches · sys.document_series (POS-, INV-, CN-, …)

 md.business_lines (supplies / construction / maintenance / cleaning) ─► gl.accounts (revenue, cost of sales)
 md.items ◄─ md.item_barcodes · md.bundle_components · md.item_prices ─► md.price_levels
     └─ md.item_categories · md.units · md.vat_categories          md.customers (VAT registered + TRN)

 sales.quotations ─► sales.quotation_lines
        │ convert / link payments
        ▼
 sales.documents (invoice · advance_invoice · credit_note · debit_note) ─► sales.document_lines
        ▲   ▲   ▲                         (item · advance · advance_deduction)       │
        │   │   └─ sales.credit_allocations                                         │ stock
        │   └───── sales.payment_allocations ◄─ sales.payments                       ▼
        │                                          │ cash → shift        inv.movements ─► inv.balances (derived)
        │                                          ▼                         ▲        ▲
        │                               cash.shifts ◄─ cash.registers        │        └─ inv.count_lines ◄─ inv.counts
        │                               cash.counts · cash.movements ·       └─ inv.adjustment_lines ◄─ inv.adjustments
        │                               cash.drawer_events                                  (incl. oversell, pending review)
        └── every financial event ─► gl.journal_entries ─► gl.journal_lines ─► gl.accounts      gl.periods (monthly)

 audit.log (hash-chained) ◄─ every table + explicit events         ops.outbox · ops.backup_runs · ops.integrity_runs · ops.backup_requests · ops.update_state · ops.update_requests · ops.server_health
```

---

## 4. Schema `sys`

### 4.1 `sys.schema_migrations`

Written only by the migration runner.

| Column | Type | Rules |
|---|---|---|
| version | integer PK | |
| name | text | |
| checksum_sha256 | text | The runner refuses to start if an applied file changed |
| applied_at | timestamptz | |
| applied_by | text | |
| execution_ms | integer | |

### 4.2 `sys.company_profile` (exactly one row)

| Column | Type | Rules |
|---|---|---|
| id | smallint PK | `CHECK (id = 1)` |
| legal_name_ar, legal_name_en | text | |
| trade_name_ar, trade_name_en | text? | |
| vat_registered | boolean | |
| trn | char(15)? | `CHECK (trn ~ '^[0-9]{15}$')`; `CHECK (NOT vat_registered OR trn IS NOT NULL)` |
| address_ar, address_en | text | |
| city, po_box, phone, email, website | text? | |
| emirate | text? | `CHECK IN ('abu_dhabi','dubai','sharjah','ajman','umm_al_quwain','ras_al_khaimah','fujairah')` |
| logo | bytea? | ≤ 512 KB |
| logo_mime | text? | png / jpeg / svg |
| currency | char(3) | `'AED'`, `CHECK (currency = 'AED')` |
| [std] | | |

Issued documents copy the seller details into `seller_snapshot`.

### 4.3 `sys.settings`

| Column | Type | Rules |
|---|---|---|
| key | text PK | `CHECK (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$')` |
| value | jsonb | Validated per key by a Zod schema in the API |
| description | text? | |
| updated_at, updated_by, row_version | | |

The initial keys are listed in §15.4.

### 4.4 `sys.branches`

One row (Al Ain HQ) in P1.

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique |
| name_ar, name_en | text | |
| address_ar, address_en | text? | |
| [active], [std] | | |

### 4.5 `sys.document_series`

The counter is changed only by `sys.next_number()`.

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| doc_type | text | `CHECK IN ('quotation','invoice','credit_note','debit_note','receipt','refund','payment_reversal','cash_voucher','shift','stock_adjustment','stock_count','journal')`. Series of type `invoice` also number `advance_invoice` documents. |
| channel | text? | `CHECK IN ('pos','office')`; `CHECK (doc_type <> 'invoice' OR channel IS NOT NULL)`. `POS-` = `pos`, `INV-` = `office` ([0011](decisions/0011-document-numbering-series.md)). |
| branch_id | bigint → sys.branches | |
| code | text | unique (e.g. `POS`, `INV`, `CN`) |
| prefix | text | e.g. `POS-`; `UNIQUE (doc_type, prefix)` |
| number_width | smallint | `DEFAULT 6`, `CHECK 1..12` |
| start_number | bigint | `DEFAULT 1`, `CHECK > 0` (continue an old system's numbering) |
| next_number | bigint | Starts at `start_number`. Trigger: may change only to `OLD + 1`. |
| is_default | boolean | Partial unique `(doc_type, channel, branch_id) WHERE is_default AND is_active` |
| [active], [std] | | |

`sys.next_number(series_id) → (seq_no, formatted)` is `SECURITY DEFINER`. It uses `UPDATE … RETURNING`, which holds the row lock until commit. A rollback gives the number back, so there are no gaps.

### 4.6 `sys.reason_codes`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| category | text | `CHECK IN ('stock_increase','stock_decrease','stock_count','defective','write_off','oversell','credit_note','debit_note','payment_reversal','price_override','discount_override','no_sale','paid_in','paid_out','cash_recount','cash_variance','draft_discard','reprint','other')` |
| code | text | `UNIQUE (category, code)` |
| name_ar, name_en | text | |
| requires_note | boolean | `DEFAULT false` |
| gl_account_id | bigint? → gl.accounts | Account for paid-in/paid-out reasons: `CHECK ((category IN ('paid_in','paid_out')) = (gl_account_id IS NOT NULL))`; active, postable, not control |
| [active], [std] | | |

There is no `line_void` category: cart removals need no reason ([0005](decisions/0005-cart-removals-logged-without-approval.md)).

### 4.7 `sys.idempotency_keys`

Technical; not row-audited.

| Column | Type | Rules |
|---|---|---|
| key | uuid PK | Generated by the client for every save request |
| user_id | bigint → auth.users | |
| device_id | bigint → auth.devices | |
| endpoint | text | |
| request_sha256 | bytea | Same key with a different body → `409 IDEMPOTENCY_MISMATCH` |
| response_status | smallint | |
| response_body | jsonb | Returned unchanged on retry |
| created_at | timestamptz | Purged after 30 days by `artepool_maint` |

Written in the same transaction as the operation. Insert-only (a trigger stamps `created_at` with server time and refuses updates).

**One-time secrets are never stored here.** A response that carries a temporary password or PIN, a device key, an enrollment code or recovery codes is stored without the secret. A retry of that request is told the action already happened, and the person repeats the reset if they missed the secret.

### 4.8 `sys.alerts`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| alert_type | text | `CHECK IN ('low_stock','oversell_review','cash_drop_due','cash_variance','repeated_variance','drawer_left_open','backup_failed','backup_stale','restore_test_due','integrity_issue','audit_chain_broken','clock_skew','clock_backwards','period_missing','kiosk_lock_off','kiosk_lock_on','kiosk_exit_attempt','kiosk_code_blocked','offline_copy_due','ups_unconfirmed','disk_low','disk_urgent','service_down','wal_archive_failed','certificate_expiring','certificate_renewal_failed','root_ca_expiring','durability_off')` (kiosk types: migration 0034; `offline_copy_due`: 0036; the server PC's health: 0045; `durability_off`: 0047) |
| severity | text | `CHECK IN ('info','warning','critical')` |
| entity_type, entity_id | text? | |
| params | jsonb | Values for the translated message |
| dedupe_key | text | Partial unique `WHERE acknowledged_at IS NULL` |
| created_at | timestamptz | |
| acknowledged_at | timestamptz? | |
| acknowledged_by | bigint? → auth.users | |
| ack_note | text? | |

### 4.9 `sys.import_batches`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| entity | text | `CHECK IN ('items','item_prices','customers','suppliers','opening_stock','opening_balances')` |
| file_name | text | |
| file_sha256 | bytea | |
| status | text | `CHECK IN ('validated','rejected','committed')`. Validation is a dry run; commit is one transaction. |
| rows_total, rows_valid, rows_invalid | integer | `CHECK >= 0` |
| error_report | jsonb? | |
| [ins] | | |
| committed_at | timestamptz? | |
| committed_by | bigint? → auth.users | |

### 4.10 `sys.print_templates` (added by decision 0020)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| doc_kind | text | `CHECK IN ('tax_invoice_a4','quotation_a4','credit_note_a4','receipt_thermal','z_report','barcode_label')`, `UNIQUE` |
| current_version_id | bigint? → sys.print_template_versions | The version used for new documents |
| [ins] [upd] | | |

### 4.11 `sys.print_template_versions` (append-only)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| template_id | bigint → sys.print_templates | |
| version_no | integer | `UNIQUE (template_id, version_no)`, gapless per template |
| settings | jsonb | Logo position and size, main colour, print language, text size, optional-field switches, texts, margins, paper width. Validated by a Zod schema; locked tax fields are not stored as switches and are always rendered. |
| logo_sha256 | bytea? | Logo file stored by hash (content-addressed) |
| note | text? | |
| [ins] | | Never updated or deleted (`sys.forbid_update`, `sys.forbid_delete`) |

Every issued document (`sales.documents`, receipts, Z reports) stores `print_template_version_id` at issue, and reprints use that version. Office receipts store the A4 invoice template's version (they print with its design, decision 0064). `sys.print_templates.current_version_id` must be one of the template's own versions and is changed by the owner only (migration 0023). Permission: `print_templates.manage` (Owner only). The `settings` shape and the fields locked per document type are in `packages/shared/src/contracts/printing.ts` and decision 0064.

### 4.12 `sys.company_bank_accounts` (migration 0023, decision 0065)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| bank_name | text | 1–100 characters |
| account_name | text | 1–150 characters |
| iban | text | `sys.valid_uae_iban()`: `AE` + 21 digits, ISO 13616 checksum; unique among active accounts |
| swift | text? | 8 or 11 characters |
| sort_order | smallint | |
| is_active | boolean | Deactivated with a reason (`sys.add_deactivation_reason`) |
| [touch] | | Audited; never deleted; written by the owner only (`system.company.edit`, checked by a trigger) |

Which account prints is the template's `bankAccountId` setting, so a reprint shows the account printed originally.

---

### 4.13 `sys.setup_state` (exactly one row; migration 0043, decision 0102)

The first-run wizard on the server PC. Forward only, one step at a time; never deleted; audited.

| Column | Type | Notes |
|---|---|---|
| id | smallint PK | Always 1 |
| state | text | `not_started` → `in_progress` → `complete`; nothing changes once complete (`SETUP_ALREADY_DONE`) |
| path | text? | `new` / `restore`, chosen once with `in_progress`; empty on databases that existed before the wizard |
| installation_id | uuid | Names the installation; never changes |
| started_at, completed_at | timestamptz? | Set by the trigger from the server clock |
| created_*, updated_*, row_version | | `sys.add_touch` |

Migration 0043 marks it `complete` on any database that already has an active owner. The API may update `state` and `path` only.

## 5. Schema `auth`

### 5.1 `auth.users`

The audit trigger **redacts** `password_hash`, `pin_hash` and `totp_secret_enc`; it records only that they changed. It ignores `last_login_at`, `failed_login_count`, `pin_failed_count` and `totp_last_step` (lockouts and blocks are audited through `locked_until`, `pin_blocked_at` and explicit events).

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | 1 = SYSTEM (cannot sign in or be changed) |
| username | text | Unique `lower(username)`; `CHECK (username ~ '^[a-z0-9._-]{3,32}$')` |
| display_name_ar, display_name_en | text | |
| phone, email | text? | |
| sign_in_method | text | `CHECK IN ('pin','password','password_totp')`, default `password` ([0021](decisions/0021-cashier-pin-sign-in-on-pos-pcs.md)) |
| password_hash | text? | Argon2id ([0023](decisions/0023-password-rules.md)). PIN users have none; everyone else must have one |
| password_changed_at | timestamptz? | |
| must_change_password | boolean | `DEFAULT true` (temporary password from the owner) |
| pin_hash | text? | Argon2id of a 4-digit PIN. PIN users: sign-in on POS PCs; password users: supervisor approvals only |
| pin_must_change | boolean | `DEFAULT false` (temporary PIN from the owner) |
| pin_failed_count | smallint | `DEFAULT 0` |
| pin_blocked_at | timestamptz? | Set after `security.max_failed_pins` wrong PINs; cleared only by the owner |
| totp_secret_enc | bytea? | AES-256-GCM; key outside the DB (DPAPI). Present but not enabled while 2-step setup is pending |
| totp_enabled | boolean | Only for `password_totp` users |
| totp_last_step | bigint? | Blocks replay |
| failed_login_count | smallint | `DEFAULT 0` |
| locked_until | timestamptz? | |
| last_login_at | timestamptz? | |
| language | text | `DEFAULT 'ar'`, `CHECK IN ('ar','en')` |
| max_discount_bp | integer? | Overrides the role limit, `0..10000` |
| max_discount_fils | bigint? | `>= 0` |
| deactivated_at, deactivated_by | timestamptz?, bigint? | Set by a trigger from the server clock and the request context ([0026](decisions/0026-users-and-devices-never-deleted.md)) |
| deactivation_reason | text? | Required (3+ characters) while inactive; cleared on reactivation (the audit log keeps it) |
| [active], [std] | | |

**Checks:**
- `users_sign_in_ck`: PIN users have `pin_hash` and no `password_hash`; password users have `password_hash`.
- `users_hash_format_ck`: every hash starts with `$argon2id$`, so plain text can never be stored.
- `users_totp_method_ck`: `totp_enabled` only for `password_totp`.
- `users_deactivation_ck`: active ⇔ no deactivation fields; inactive ⇔ who, when and a reason.

**Owner protection** ([0025](decisions/0025-first-owner-and-pc-from-server-commands.md), [0026](decisions/0026-users-and-devices-never-deleted.md)), all `AP008`:
- at most one active user holds the `owner` role (checked under an advisory lock)
- the owner cannot be deactivated or lose the role
- the owner role cannot lose a permission or its `requires_2fa`
- `owner_only` permissions cannot be granted to any other role

**2-step rule** (`AP010`, checked at commit by deferred constraint triggers on users, user roles and roles): anyone holding an active role with `requires_2fa` must use `password_totp`.

### 5.2 `auth.roles`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique |
| name_ar, name_en | text | |
| is_system | boolean | The 5 default roles: code fixed, cannot be deactivated |
| requires_2fa | boolean | `true` for Owner, and cannot be turned off there |
| max_discount_bp | integer | `DEFAULT 0`, `0..10000` |
| max_discount_fils | bigint | `DEFAULT 0`, `>= 0` |
| [active], [std] | | |

Effective discount limit = the user override if set, otherwise the highest limit among the user's roles.

### 5.3 `auth.permissions`

Seeded by migrations; read-only for the API.

| Column | Type | Rules |
|---|---|---|
| code | text PK | `CHECK (code ~ '^[a-z_]+(\.[a-z_]+)+$')` |
| module | text | |
| name_ar, name_en | text | |
| is_sensitive | boolean | |
| approvable | boolean | A supervisor approval can stand in for it, once |
| owner_only | boolean | Only the owner role may hold it (Settings are owner-only): `users.manage`, `users.reset_credentials`, `roles.manage`, `system.devices.manage`, `system.settings.edit`, `system.series.manage`, and from 0007 `system.company.edit` ([0030](decisions/0030-company-details-owner-only.md)) |

`auth.user_has_permission(user_id, code)` is true when an active user holds the permission through an active role.

### 5.4 `auth.role_permissions` (link; DELETE allowed)

| Column | Type | Rules |
|---|---|---|
| role_id | bigint → auth.roles | PK part |
| permission_code | text → auth.permissions | PK part |
| granted_at | timestamptz | |
| granted_by | bigint → auth.users | |

### 5.5 `auth.user_roles` (link; DELETE allowed)

| Column | Type | Rules |
|---|---|---|
| user_id | bigint → auth.users | PK part |
| role_id | bigint → auth.roles | PK part |
| granted_at | timestamptz | |
| granted_by | bigint → auth.users | |

### 5.6 `auth.devices`

Enrolled PCs only ([0024](decisions/0024-device-enrollment-proves-the-server.md)). The audit trigger redacts `key_hash`. A revoked device can never change again ([0026](decisions/0026-users-and-devices-never-deleted.md)); the same PC comes back only as a new row.

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | `CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$')` (the Windows computer name, e.g. `COUNTER-01`); unique `upper(code)` among active devices |
| name | text | Free description, 1–100 characters |
| device_kind | text | `CHECK IN ('pos','office','warehouse','server')`. PIN sign-in only on `pos` |
| branch_id | bigint → sys.branches | |
| default_warehouse_id | bigint? → md.warehouses | FK added by 0009 (master data; the comment in 0005 says 0007, written before 0006 and 0007 were used in M1) |
| status | text | `CHECK IN ('active','revoked')`, default `active` |
| key_hash | bytea | Unique; SHA-256 of the 256-bit device key |
| key_expires_at | timestamptz | `> enrolled_at`; renewed automatically (`security.device_key_days`) |
| key_renewed_at | timestamptz? | Server time, set by trigger when `key_hash` changes |
| enrolled_at | timestamptz | Server time, set by trigger |
| enrolled_by | bigint → auth.users | The user who created the enrollment code |
| printer_config | jsonb | `DEFAULT '{}'`. Key `label` (migration 0038, decision 0096): this PC's label printer `{printer, dpi (203/300), printableWidthMm (20–120), offsetXMm, offsetYMm (−10–10)}` plus, since 0039, optional `darkness` (0–15), `speed` (1–6), `mode` (`driver`/`tspl`), checked by `auth.valid_label_printer`; set by the owner through `PUT /api/v1/devices/me/label-printer` (audited). The receipt printer stays on the PC (decision 0070) |
| revoked_at, revoked_by | timestamptz?, bigint? | Set by trigger from the server clock and the request context |
| revoke_reason | text? | Required (3+ characters) when revoked |
| [std] | | |

**`auth.device_activity`** (technical, not row-audited, never deleted): `device_id` PK → devices, `last_seen_at`, `last_ip` inet, `app_version`. Updated on every request without a user context.

### 5.6a `auth.enrollment_codes`

One-time codes for enrolling a PC ([0024](decisions/0024-device-enrollment-proves-the-server.md)). The code itself is never stored.

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| origin | text | `CHECK IN ('settings','console')` |
| key_salt | bytea | 16 bytes |
| code_key | bytea | 32 bytes: Argon2id(code, salt). Redacted in the audit log |
| expires_at | timestamptz | `> created_at` and at most 1 hour later (default `security.enrollment_code_minutes` = 10) |
| failed_attempts | smallint | Ignored by the audit trigger (failures are explicit events); cancelled at `security.enrollment_max_attempts` |
| used_at, used_device_id | timestamptz?, bigint? → devices | Set once, before expiry; server time |
| cancelled_at, cancel_reason | timestamptz?, text? | `replaced`, `too_many_attempts`, `cancelled` |
| [ins] | | |

At most one open code (unique partial index); used or cancelled codes are final.

### 5.7 `auth.sessions`

Not row-audited. Sign-in, sign-out, lock, unlock and switch are explicit audit events. Ended with a reason, never deleted.

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| token_hash | bytea | Unique; SHA-256 of the opaque 256-bit token |
| user_id | bigint → auth.users | |
| device_id | bigint → auth.devices | |
| stage | text | `CHECK IN ('second_factor','full')`. A password + 2-step sign-in first gets a short `second_factor` session, then a new `full` session with a new token |
| auth_method | text | `CHECK IN ('password','password_totp','recovery_code','pin','trusted_device')` (`trusted_device` from 0006); `second_factor` only with `password` |
| created_at, last_activity_at | timestamptz | Server time at insert |
| idle_timeout_sec | integer | `> 0` (5 / 15 minutes by device kind) |
| expires_at | timestamptz | `> created_at`, at most 24 hours later |
| locked_at | timestamptz? | Idle or manual lock; unlocked by re-entering the same credential |
| ended_at | timestamptz? | Server time; an ended session is final |
| end_reason | text? | `CHECK IN ('logout','expired','revoked','user_switch','credential_changed','device_revoked','user_deactivated','upgraded','locked_out')` |
| client_ip | inet? | |

**Insert rules** (`AP010`, [0021](decisions/0021-cashier-pin-sign-in-on-pos-pcs.md)): the user is active and not SYSTEM; the device is active with an unexpired key; `pin` only for PIN users on `pos` devices; `password_totp` / `recovery_code` / `trusted_device` only for 2-step users (`password_totp` and `trusted_device` need `totp_enabled`); a `full` password-only session only while the 2-step code is not set up; `trusted_device` only on a non-POS PC with an open, unexpired `auth.device_trust` row that is also younger than the current `security.trusted_device_days` (and never when that setting is 0).

### 5.8 `auth.approvals` (single-use)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| permission_code | text → auth.permissions | The action approved (must be `approvable`) |
| requested_by | bigint → auth.users | Set from the request context |
| approved_by | bigint → auth.users | `CHECK (approved_by <> requested_by)`; must hold the permission |
| device_id | bigint → auth.devices | Set from the request context (required) |
| reason_code_id | bigint? → sys.reason_codes | FK added by 0009 (master data) |
| reason_text | text | `CHECK (length(btrim(reason_text)) >= 3)` |
| context | jsonb | e.g. `{"item_id":42,"qty_short":"2.000"}`, `{"discount_bp":1500,"limit_bp":1000}` |
| approved_at | timestamptz | Server time |
| expires_at | timestamptz | `approved_at + security.approval_validity_seconds` (default 5 min), at most 1 hour |
| consumed_at | timestamptz? | Set exactly once, server time |
| consumed_entity | text? | e.g. `sales.documents:123` |

Insert and use refusals raise `AP009`: self-approval, an approver without the permission, a non-approvable permission, a second use, use after expiry, or use by anyone other than the requester.

### 5.9 `auth.recovery_codes`

The owner's 10 one-time 2-step recovery codes ([0022](decisions/0022-owner-2-step-recovery.md)).

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| user_id | bigint → auth.users | |
| code_hash | text | Argon2id (`$argon2id$…`); redacted in the audit log |
| used_at | timestamptz? | Set once, server time |
| revoked_at | timestamptz? | Set when a new set replaces it; never both used and revoked |
| [ins] | | |

Also used, together with the 6-digit code, to recover a forgotten password in the app ([0028](decisions/0028-forgot-password-with-phone-and-recovery-code.md)).

### 5.10 `auth.device_trust` (migration 0006)

"Trust this PC" for the 2-step code ([0027](decisions/0027-trust-this-pc-for-the-2-step-code.md)): on a trusted PC, the person signs in with the password alone until the trust ends. Row-audited; ended with a reason, never deleted.

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| user_id | bigint → auth.users | Must have an active 2-step code |
| device_id | bigint → auth.devices | Active and not `pos` |
| created_at, created_by | timestamptz, bigint → auth.users | Stamped; `created_by = user_id` |
| expires_at | timestamptz | Set by the server: `created_at + security.trusted_device_days` (default 30, range 0–90); at most 90 days |
| ended_at | timestamptz? | Server time; an ended trust is final |
| end_reason | text? | `CHECK IN ('replaced','ended_in_settings','password_changed','two_step_changed','user_deactivated','device_revoked','device_kind_changed')` |

**Rules:**
- **Insert** (`AP010`): only the person themselves, on that same PC (from the request context), while the setting is above 0.
- **One open trust** per person and PC (unique partial index).
- **Automatic ending** (triggers):
  - on `auth.users`: a new password (`password_changed_at` changes, or a reset sets `must_change_password` with a new hash), a 2-step change (`totp_enabled` or `totp_secret_enc`), or deactivation;
  - on `auth.devices`: revoke, or the type changing to `pos`.

### 5.11 `auth.kiosk_lock_changes` (migration 0034, append-only)

The "Kiosk lock" of each POS PC ([0082](decisions/0082-app-mode-by-device-kind-and-pos-kiosk.md), [0083](decisions/0083-exiting-kiosk-mode-owner-only.md), [0089](decisions/0089-kiosk-lock-switch-per-pos-device.md)). Every change is a row; the latest row of a PC is its state; no row = on. Row-audited, immutable, never deleted.

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| device_id | bigint → auth.devices | An active `pos` PC |
| lock_on | boolean | |
| off_until | timestamptz? | Off: until when (empty = until turned back on); on: always empty (`kiosk_lock_on_ck`) |
| via | text | `CHECK IN ('settings','owner_code')`; `owner_code` is always off with an end time (`kiosk_lock_code_ck`), at most 15 minutes ahead (0091) |
| reason | text? | 3–500 characters; required from Settings |
| created_at, created_by | timestamptz, bigint → auth.users | Stamped |

**Insert rules** (trigger): the user in the request context is the owner (`auth.is_owner`, `AP010`); the PC is an active POS PC; a reason when `via = 'settings'`; `off_until` later than now; by owner code at most 15 minutes ahead (5 in migration 0034, 15 from 0035). The API also checks the owner's fresh 2-step code (claimed once, shared with sign-in and approvals).

`auth.kiosk_state(device_id) → (locked, off_until, change_id, owner_signed_in)`: locked unless the latest change is "off" and its time has not passed, or the owner is signed in on that PC (`auth.owner_signed_in_on`: an open, full, unlocked, unexpired owner session there; migration 0035, [0091](decisions/0091-kiosk-lock-off-while-the-owner-is-signed-in.md)).

### 5.12 `auth.kiosk_code_failures` (migration 0034, append-only)

Wrong owner codes typed on a POS PC's lock screen: 5 within 15 minutes close the owner-code unlock on that PC for 15 minutes and raise `kiosk_code_blocked`. Columns: id, device_id → auth.devices, created_at, created_by. Row-audited, immutable, never deleted.

---

## 6. Schema `audit`

### 6.1 `audit.log` (append-only, hash-chained)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| chain_seq | bigint? | Unique; assigned when sealed at commit; consecutive |
| occurred_at | timestamptz | `DEFAULT clock_timestamp()` |
| tx_id | xid8 | `DEFAULT pg_current_xact_id()` |
| request_id | uuid? | |
| user_id | bigint? | No FK (the log stands alone). `CHECK (user_id IS NOT NULL OR action LIKE 'event:auth.%')` |
| device_id, session_id | bigint? | |
| client_ip | inet? | |
| client_time | timestamptz? | The PC's clock (tamper detection) |
| action | text | `insert` / `update` / `delete`, or `event:<name>`. Events include `event:auth.login_failed`, `event:pos.cart_line_removed`, `event:pos.cart_qty_reduced`, `event:pos.cart_cleared`, `event:pos.no_sale`, `event:doc.print` (format thermal/a4, reprint flag), `event:export.file`, `event:shift.x_report`, `event:audit.verify`. |
| entity_type, entity_id | text? | |
| old_values, new_values | jsonb? | Changed columns only; secrets redacted |
| reason | text? | |
| approval_id | bigint? | |
| prev_hash | bytea? | Set at seal |
| row_hash | bytea? | Set at seal; unique |

**Indexes:** `(occurred_at)`, `(entity_type, entity_id)`, `(user_id, occurred_at)`, `(action, occurred_at)`, `(tx_id) WHERE row_hash IS NULL`.

**Guards:**
- No UPDATE, except sealing columns from NULL inside `audit.seal_transaction()`.
- No DELETE; TRUNCATE is blocked.
- The API writes only through triggers and `audit.record_event()`.

**Hash input:** a canonical, time-zone-independent text built from:
- `prev_hash` and `chain_seq`
- `occurred_at` as epoch microseconds
- all columns
- `old_values::text` and `new_values::text`

### 6.2 `audit.chain_head` (one row)

| Column | Type | Rules |
|---|---|---|
| id | smallint PK | `CHECK (id = 1)` |
| last_seq | bigint | |
| last_hash | bytea | Genesis = SHA-256 of `'ARTEPOOL-ERP-GENESIS'` + the installation UUID |
| updated_at | timestamptz | |

### 6.3 `audit.anchors` (append-only)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| chain_seq | bigint | |
| chain_hash | bytea | |
| anchor_kind | text | `CHECK IN ('z_report','backup','daily','manual')` |
| reference | text | e.g. `shift:Z-000123` |
| [ins] | | |

### 6.4 `audit.verifications`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| started_at | timestamptz | |
| finished_at | timestamptz? | |
| triggered_by | bigint → auth.users | |
| from_seq, to_seq | bigint | |
| rows_checked | bigint? | |
| result | text? | `CHECK IN ('ok','broken','error')` |
| first_bad_seq | bigint? | |
| details | jsonb? | Includes the anchor comparison |

---

## 7. Schema `md` (master data)

### 7.1 `md.units`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique |
| name_ar, name_en | text | |
| decimals | smallint | `CHECK 0..3` (pieces 0, kg 3) |
| einvoice_code | text? | UN/ECE Rec 20 (`H87`, `KGM`, `LTR`, `MTR`, `HUR`) |
| [active], [std] | | |

### 7.2 `md.vat_categories`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique: `SR` (5%), `ZR`, `EX`, `OS`. Exactly these four, fixed ([0033](decisions/0033-four-fixed-uae-vat-categories.md)): the API may change only the rate. |
| name_ar, name_en | text | |
| rate_bp | integer | `CHECK 0..10000`. Changed by the owner only (`system.settings.edit`), with a reason; applies to new documents only ([0033](decisions/0033-four-fixed-uae-vat-categories.md)). |
| einvoice_code | text | `CHECK IN ('S','Z','E','O')`; `CHECK ((einvoice_code = 'S') = (rate_bp > 0))` |
| [active], [std] | | |

Lines copy the code and rate, so a rate change never alters history.

### 7.3 `md.business_lines`

Lines of business ([0018](decisions/0018-chart-of-accounts-and-posting-map.md)).

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique: `supplies`, `construction`, `maintenance`, `cleaning` |
| name_ar, name_en | text | |
| revenue_account_id | bigint → gl.accounts | e.g. 4100 Revenue – pool supplies |
| cogs_account_id | bigint → gl.accounts | e.g. 5100 Cost of sales – pool supplies |
| sort_order | integer | |
| [active], [std] | | |

### 7.4 `md.item_categories`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| parent_id | bigint? → md.item_categories | `CHECK (parent_id <> id)`; cycles blocked by trigger |
| code | text | unique |
| name_ar, name_en | text | |
| sort_order | integer | |
| [active], [std] | | |

### 7.5 `md.items`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique. Suggested by the app; fixed after creation (trigger, [0037](decisions/0037-master-data-defaults.md)) |
| item_type | text | `CHECK IN ('stock','service','bundle')`. Trigger: fixed after first use. |
| name_ar, name_en | text | |
| description_ar, description_en | text? | |
| search_key | text | Generated; GIN trigram |
| category_id | bigint → md.item_categories | |
| unit_id | bigint → md.units | |
| vat_category_id | bigint → md.vat_categories | Per-item VAT rate |
| default_business_line_id | bigint? → md.business_lines | If set, overrides the document's line of business (e.g. a cleaning service sold at the POS) |
| reorder_level | numeric(14,3)? | `>= 0`; stock items only |
| reorder_qty | numeric(14,3)? | `> 0` |
| fallback_unit_cost_4dp | bigint? | `>= 0`. **The item's purchase price, without VAT** ([0038](decisions/0038-item-purchase-price-owner-only.md)): stock items and services only (a kit's cost is the sum of its components). Setting or changing it needs `items.cost` (owner-only; trigger `c_item_cost_rules`, migration 0010). It values sales and approved oversells until a weighted-average cost exists. |
| pack_ar, pack_en | text? | 1–40 characters (migration 0040, decision [0097](decisions/0097-label-designer-and-print-quality.md)): the sale pack printed on labels ("كيس 25 كجم" / "25 kg bag"); empty = the unit's name |
| is_sellable | boolean | `DEFAULT true` |
| [active], [std] | | |

The average cost is not stored on the item. It lives in `inv.balances.avg_unit_cost_4dp`.

### 7.6 `md.item_barcodes`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| item_id | bigint → md.items | |
| barcode | text | `CHECK (barcode ~ '^[0-9A-Za-z.\-]{3,64}$')`; unique on `upper(barcode)` `WHERE is_active`; never changes or moves to another item (deactivate and add a new one) |
| qty_per_scan | numeric(14,3) | `DEFAULT 1`, `> 0` (pack barcodes) |
| is_primary | boolean | One primary active barcode per item |
| [active], [std] | | |

### 7.7 `md.bundle_components` (link; DELETE allowed)

| Column | Type | Rules |
|---|---|---|
| bundle_item_id | bigint → md.items | PK part; must be a `bundle` |
| component_item_id | bigint → md.items | PK part; `stock` or `service`; `<> bundle_item_id` |
| quantity | numeric(14,3) | `> 0` |
| [std] | | |

### 7.8 `md.price_levels` (decision [0032](decisions/0032-one-sale-price-with-vat-flag-and-customer-types.md))

One level (`STANDARD`) in P1. A second level (for example "Contractors & companies") can be added later without changing existing data; there is no screen for it in P1.

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique (`STANDARD`) |
| name_ar, name_en | text | |
| is_default | boolean | Exactly one active default |
| customer_types | text[] | `DEFAULT '{}'`; subset of `individual`, `contractor`, `company`. The default level lists none and applies to everyone; a customer type is listed on at most one active level. |
| sort_order | integer | |
| [active], [std] | | |

**Choosing a price (M4):** the level that lists the customer's type, if the item has a price there; otherwise the default level.

### 7.9 `md.item_prices`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| price_level_id | bigint → md.price_levels | `UNIQUE (price_level_id, item_id)` |
| item_id | bigint → md.items | |
| price_4dp | bigint | `>= 0`; 4-decimal unit price |
| includes_vat | boolean | "Price includes VAT" (set on the item screen). Inclusive prices are split back into net and VAT; exclusive prices have VAT added ([0009](decisions/0009-vat-per-line.md)). |
| [std] | | History is in the audit log |

### 7.10 `md.customers`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique |
| customer_type | text | `CHECK IN ('individual','contractor','company')`, required ([0032](decisions/0032-one-sale-price-with-vat-flag-and-customer-types.md)). Never changes the VAT. |
| name | text | |
| name_alt | text? | |
| search_key | text | Generated (code, names, phone, TRN) |
| is_vat_registered | boolean | `DEFAULT false`. Decides the invoice format ([0010](decisions/0010-invoice-format-by-vat-registration.md)). |
| trn | char(15)? | `CHECK (trn ~ '^100[0-9]{12}$')`; `CHECK (NOT is_vat_registered OR trn IS NOT NULL)`; unique ([0037](decisions/0037-master-data-defaults.md)) |
| phone, phone_alt | text? | E.164. `phone` required except for the walk-in customer; unique ([0037](decisions/0037-master-data-defaults.md)) |
| email | text? | |
| address_line, area, city, po_box | text? | |
| emirate | text? | |
| country_code | char(2) | `'AE'` |
| credit_mode | text | `CHECK IN ('cash','credit')`, `DEFAULT 'cash'` ([0036](decisions/0036-customers-start-as-cash.md)) |
| payment_terms_days | smallint | `DEFAULT 0`, `0..365`; 0 when cash |
| credit_limit_fils | bigint | `DEFAULT 0`; 0 when cash, `> 0` when credit |
| is_walk_in | boolean | Exactly one "Cash customer"; it cannot be changed or deactivated and is always cash |
| preferred_language | text? | |
| notes | text? | |
| [active], [std] | | |

**Credit rule (database trigger):** a change to `credit_mode`, `payment_terms_days` or `credit_limit_fils` (and any customer created as credit) needs a user with `customers.credit` and a reason in the request context.

### 7.11 `md.suppliers`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique |
| name | text | |
| name_alt | text? | |
| search_key | text | Generated |
| is_vat_registered | boolean | |
| trn | char(15)? | As customers (15 digits starting with 100; unique among suppliers) |
| phone, email, address_line, city, emirate | text? | |
| country_code | char(2) | |
| payment_terms_days | smallint | |
| notes | text? | |
| [active], [std] | | |

### 7.12 `md.technicians`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique |
| name_ar, name_en | text | |
| phone | text? | |
| user_id | bigint? → auth.users | unique; optional |
| [active], [std] | | |

### 7.13 `md.payment_methods`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique |
| name_ar, name_en | text | |
| kind | text | `CHECK IN ('cash','card','bank_transfer','cheque','other')` |
| gl_account_id | bigint → gl.accounts | 1110 / 1150 / 1140 / 1160 … |
| opens_drawer | boolean | |
| gives_change | boolean | `CHECK (NOT gives_change OR kind = 'cash')` |
| requires_reference | boolean | |
| in_pos, in_office | boolean | |
| sort_order | integer | |
| [active], [std] | | |

### 7.14 `md.warehouses`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique |
| name_ar, name_en | text | |
| branch_id | bigint → sys.branches | |
| warehouse_type | text | `CHECK IN ('store','van','site')` |
| technician_id | bigint? → md.technicians | Required for `van` |
| is_default | boolean | Exactly one per branch: choosing a new default takes the mark from the old one; the mark cannot simply be removed |
| [active], [std] | | |

### 7.15 `md.cash_denominations`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| value_fils | bigint | unique, `> 0` |
| kind | text | `CHECK IN ('note','coin')` |
| sort_order | integer | |
| [active], [std] | | |

### 7.16 `md.label_sizes` (decisions [0043](decisions/0043-barcode-label-sizes.md), [0096](decisions/0096-barcode-labels-2-inch-printer.md); migrations 0011, 0037)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique (case-insensitive); fixed after creation |
| name_ar, name_en | text | |
| width_mm | smallint | 10–210; an active size is never wider than the setting `labels.max_width_mm` (50 mm, the label roll; trigger `b_label_size_fits_roll`, rule `LABEL_TOO_WIDE`) |
| height_mm | smallint | 10–297 |
| sort_order | smallint | |
| [active], [std] | | Deactivated with a reason, never deleted |

Seeded: 25×15, 30×20, 38×25, 40×30, 50×25, 50×30, 58×40, 100×50 mm. Since 0037 (decision 0096) the active ones are 50×30 (first = default), 50×25, 40×30 and 38×25; 25×15, 30×20, 58×40 and 100×50 are deactivated. Writes need `system.settings.edit` (owner).

---

## 8. Schema `inv`

### 8.1 `inv.movements` (append-only stock ledger)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| movement_type | text | `CHECK IN ('opening','sale','sale_return','adjustment_in','adjustment_out','oversell_in','status_out','status_in','write_off','count_gain','count_loss')` |
| occurred_at | timestamptz | |
| movement_date | date | Dubai business date; must be in an open period |
| item_id | bigint → md.items | `stock` items only |
| warehouse_id | bigint → md.warehouses | Always required |
| stock_status | text | `CHECK IN ('available','defective')` |
| quantity | numeric(14,3) | Signed; sign checked per type |
| value_4dp | bigint | Signed **exact stock value** at 4-decimal precision. **Outbound: computed by the trigger.** Inbound: supplied by the API (`qty × unit cost`, rounded to 4 dp by the helper). |
| value_fils | bigint | Signed **book amount** posted to the ledger. Set by the trigger as `round_fils(value_after_4dp) − round_fils(value_before_4dp)`. Because these amounts telescope, the books always equal the rounded stock value, with no drift ([0014](decisions/0014-money-precision-and-rounding.md)). |
| unit_cost_4dp | bigint | Set by trigger: \|value_4dp\| ÷ \|quantity\| (information) |
| qty_after | numeric(14,3) | Set by trigger |
| value_after_4dp | bigint | Set by trigger |
| sales_document_line_id | bigint? → sales.document_lines | `sale`, `sale_return` |
| adjustment_line_id | bigint? → inv.adjustment_lines | `opening`, `adjustment_*`, `oversell_in`, `status_*`, `write_off` |
| count_line_id | bigint? → inv.count_lines | `count_gain`, `count_loss` |
| approval_id | bigint? → auth.approvals | |
| reason_code_id | bigint? → sys.reason_codes | |
| [ins] | | |

**Checks:**
- `num_nonnulls(sales_document_line_id, adjustment_line_id, count_line_id) = 1`, and it matches the type.
- `quantity > 0` for `opening`, `sale_return`, `adjustment_in`, `oversell_in`, `status_in`, `count_gain`.
- `quantity < 0` for `sale`, `adjustment_out`, `status_out`, `write_off`, `count_loss`.
- `value_4dp = 0 OR sign(value_4dp) = sign(quantity)`.
- `value_fils = 0 OR sign(value_fils) = sign(quantity)`.

**Trigger `inv.apply_movement()`** (`BEFORE INSERT`, `SECURITY DEFINER`):
1. Upserts and locks the balance row.
2. Outbound `value_4dp`:
   - all remaining stock → the exact remaining value
   - otherwise → `value_4dp × |qty| ÷ on-hand`, rounded to 4 dp by `sys.round_div`
3. **Rejects** negative results (`STOCK_INSUFFICIENT`).
4. Sets `value_fils` as the change in the rounded running value.
5. Updates the balance and recomputes `avg_unit_cost_4dp`.

**Worked example** (one balance row):

| Step | value_4dp | Stock value | value_fils (books) | Average |
|---|---|---|---|---|
| Receive 10 × 1.2345 | +12.3450 | 12.3450 | +12.35 | 1.2345 |
| Issue 3 | −3.7035 | 8.6415 | −3.71 (12.35 → 8.64) | 1.2345 |
| Issue 7 | −8.6415 | 0.0000 | −8.64 (8.64 → 0.00) | 1.2345 (kept as last) |

Books: 12.35 − 3.71 − 8.64 = **0.00**, exactly matching the stock.

### 8.2 `inv.balances` (derived: trigger only)

| Column | Type | Rules |
|---|---|---|
| item_id, warehouse_id, stock_status | | PK |
| quantity | numeric(14,3) | `CHECK (quantity >= 0)`: **the database cannot hold negative stock** |
| value_4dp | bigint | Exact stock value (4 dp). `CHECK (value_4dp >= 0)`; `CHECK (quantity <> 0 OR value_4dp = 0)` |
| book_value_fils | bigint | `= round_fils(value_4dp)`, and always equal to `SUM(value_fils)` of the movements: what the ledger holds for this row |
| avg_unit_cost_4dp | bigint? | `round(value_4dp ÷ quantity)` when quantity > 0. **Kept as the last known average** when quantity returns to 0 (used to value an oversell). |
| last_movement_id | bigint → inv.movements | |
| updated_at | timestamptz | |

Not row-audited (derived). The nightly check compares `quantity`, `value_4dp` and `book_value_fils` with `SUM` over the movements. It also checks that Σ `book_value_fils` equals the inventory accounts in the ledger.

### 8.3 `inv.adjustments` (document)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| uuid | uuid | |
| kind | text | `CHECK IN ('opening','increase','decrease','status_change','write_off','oversell')` |
| status | text | `CHECK IN ('draft','posted','cancelled')` |
| series_id | bigint → sys.document_series | `ADJ-` |
| seq_no | bigint? | At posting; `UNIQUE (series_id, seq_no)` |
| doc_number | text? | `CHECK ((status = 'posted') = (seq_no IS NOT NULL))` |
| warehouse_id | bigint → md.warehouses | |
| adjustment_date | date | |
| reason_code_id | bigint → sys.reason_codes | Mandatory |
| note | text? | |
| approval_id | bigint? → auth.approvals | Above threshold; `CHECK (kind <> 'oversell' OR approval_id IS NOT NULL)` |
| sales_document_id | bigint? → sales.documents | For `oversell`: the sale that needed it. `CHECK ((kind = 'oversell') = (sales_document_id IS NOT NULL))` |
| review_status | text | `CHECK IN ('not_required','pending','reviewed')`; `CHECK ((kind = 'oversell') = (review_status <> 'not_required'))` ([0003](decisions/0003-pos-oversell-with-approval.md)) |
| reviewed_by | bigint? → auth.users | |
| reviewed_at | timestamptz? | |
| review_note | text? | Required when reviewed |
| import_batch_id | bigint? → sys.import_batches | |
| total_value_fils | bigint? | Signed; at posting |
| posted_at | timestamptz? | |
| posted_by | bigint? → auth.users | |
| [std] | | |

After posting, only the `review_*` columns may change, and only `pending → reviewed`.

### 8.4 `inv.adjustment_lines` (DELETE only while draft)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| adjustment_id | bigint → inv.adjustments | `UNIQUE (adjustment_id, line_no)` |
| line_no | smallint | |
| item_id | bigint → md.items | Stock items |
| stock_status | text | Source status |
| target_status | text? | `status_change` only; must differ |
| quantity | numeric(14,3) | `> 0` |
| entered_unit_cost_4dp | bigint? | `opening` / `increase`: entered by the user. `oversell`: current or last average, else the fallback cost; blocked if none. |
| value_4dp | bigint? | At posting, from the movement(s) |
| value_fils | bigint? | At posting: the book amount from the movement(s) |
| note | text? | |

### 8.5 `inv.counts` (document)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| uuid | uuid | |
| series_id | bigint → sys.document_series | `CNT-` |
| seq_no | bigint? | At posting |
| doc_number | text? | At posting |
| warehouse_id | bigint → md.warehouses | |
| status | text | `CHECK IN ('draft','counting','posted','cancelled')` |
| scope | text | `CHECK IN ('full','category','selected')` |
| category_id | bigint? → md.item_categories | |
| snapshot_at | timestamptz? | |
| approval_id | bigint? → auth.approvals | Variance value above threshold |
| note | text? | |
| posted_at | timestamptz? | |
| posted_by | bigint? → auth.users | |
| [std] | | |

As built (migration 0011): a count is created straight in `counting` (the snapshot is taken then); `count_date`, `total_value_fils` (net) and `variance_abs_fils` (Σ |differences|, used for the approval threshold when one is set: decisions 0041, 0054) are set at posting; **one open count per warehouse** (`counts_open_uq`). Counted quantities are hidden from the counters while counting (decision 0044, API).

### 8.6 `inv.count_lines`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| count_id | bigint → inv.counts | `UNIQUE (count_id, item_id, stock_status)` |
| item_id | bigint → md.items | |
| stock_status | text | |
| system_qty | numeric(14,3) | Snapshot |
| counted_qty | numeric(14,3)? | `>= 0` |
| movement_since_snapshot | numeric(14,3)? | At posting |
| variance_qty | numeric(14,3)? | At posting: `counted − (system + movement_since_snapshot)` |
| counted_by | bigint? → auth.users | |
| counted_at | timestamptz? | |
| reason_code_id | bigint? → sys.reason_codes | Required when variance ≠ 0 |
| note | text? | |

### 8.7 `inv.label_prints` (append-only; migration 0041, decision [0099](decisions/0099-batch-labels-and-price-changed-list.md))

Every barcode label print, one row per item, with the price on the label. The "price changed, label is old" list compares each active item's last row (when it had a price) with its price today.

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| item_id | bigint → md.items | Index `(item_id, id DESC)` |
| label_size_id | bigint → md.label_sizes | |
| design_version_id | bigint → sys.print_template_versions | The label design used |
| copies | integer | `1..10000` |
| source | text | `CHECK IN ('item','list','price_changed','stock_document')` |
| price_4dp | bigint? | The sale price on the label; all four price columns empty when the label had no price |
| includes_vat | boolean? | |
| vat_rate_bp | integer? | `0..10000`: the rate of the item's VAT category at printing |
| gross_fils | bigint? | The price with VAT on the label (shared rounding helper) |
| device_id | bigint? → auth.devices | `DEFAULT sys.ctx_device_id()`: the PC that printed |
| created_at, created_by | | Who and when |

Trigger `b_label_print_rules`: refuses (`AP011`, `LABEL_PRICE_CHANGED`) a row whose price, "includes VAT" or rate is not the item's today. Never changed or deleted; audited. The API may insert only the columns above (never `device_id` or the stamps).

---

## 9. Schema `sales`

### 9.1 `sales.quotations` (numbered at first save; editable while draft; revisions after sent)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| uuid | uuid | |
| series_id | bigint → sys.document_series | `Q-` |
| seq_no | bigint | `UNIQUE (series_id, seq_no, revision)` |
| doc_number | text | |
| revision | smallint | `DEFAULT 1` |
| revised_from_id | bigint? → sales.quotations | |
| status | text | `CHECK IN ('draft','sent','accepted','rejected','expired','converted','cancelled','superseded')` |
| branch_id | bigint → sys.branches | |
| business_line_id | bigint → md.business_lines | |
| customer_id | bigint → md.customers | |
| bill_to_name | text | Snapshot |
| bill_to_name_alt, bill_to_trn, bill_to_address, bill_to_phone | text? | Snapshot |
| customer_po | text? | Customer PO number, up to 50 characters (decision 0066) |
| quotation_date | date | |
| valid_until | date | `>= quotation_date` |
| price_level_id | bigint → md.price_levels | Level used to price the lines ([0032](decisions/0032-one-sale-price-with-vat-flag-and-customer-types.md)) |
| salesperson_id | bigint? → auth.users | |
| subject | text? | |
| terms_ar, terms_en, notes | text? | |
| discount_total_fils, net_fils, vat_fils, total_fils | bigint | `>= 0`; `total = net + vat`; non-optional lines only |
| approval_id | bigint? → auth.approvals | A discount above the limit, approved when sent (`sales.discount_over_limit` only) |
| price_approval_id | bigint? → auth.approvals | Changed prices, approved when sent (`sales.price_override` only; migration 0018) |
| converted_document_id | bigint? → sales.documents | |
| sent_at, decided_at | timestamptz? | |
| [std] | | |

### 9.2 `sales.quotation_lines` (DELETE only while draft)

The money columns work exactly as in `sales.document_lines` (item lines only).

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| quotation_id | bigint → sales.quotations | `UNIQUE (quotation_id, line_no)` |
| line_no | smallint | |
| item_id | bigint → md.items | |
| description_ar, description_en | text | |
| unit_id | bigint → md.units | |
| business_line_id | bigint → md.business_lines | |
| quantity | numeric(14,3) | `> 0` |
| list_price_4dp, unit_price_4dp | bigint | `>= 0` |
| price_includes_vat | boolean | Snapshot of the item price's switch ([0032](decisions/0032-one-sale-price-with-vat-flag-and-customer-types.md)) |
| amount_before_discount_fils | bigint | `round_fils(qty × unit_price_4dp)` |
| line_discount_bp | integer? | If entered as % |
| line_discount_fils, doc_discount_alloc_fils | bigint | `>= 0` |
| net_fils, vat_fils, gross_fils | bigint | `gross = net + vat` |
| vat_category_id | bigint → md.vat_categories | |
| vat_rate_bp | integer | |
| is_optional | boolean | Excluded from totals |
| note | text? | |

### 9.3 `sales.documents` (tax documents; immutable after issue)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| uuid | uuid | e-invoice identifier |
| doc_type | text | `CHECK IN ('invoice','advance_invoice','credit_note','debit_note')`. `advance_invoice` = tax invoice for a payment received ([0013](decisions/0013-advance-and-progress-payments-vat.md)). |
| invoice_format | text | `CHECK IN ('full','simplified')`; for issued documents `CHECK ((invoice_format = 'full') = (bill_to_trn IS NOT NULL))` ([0010](decisions/0010-invoice-format-by-vat-registration.md)) |
| status | text | `CHECK IN ('draft','issued','discarded')` |
| series_id | bigint → sys.document_series | Trigger: series type matches; `channel` matches the series channel (POS → `POS-`, office → `INV-`) |
| seq_no | bigint? | At issue; `UNIQUE (series_id, seq_no)` |
| doc_number | text? | e.g. `POS-000123`, `INV-000045` |
| channel | text | `CHECK IN ('pos','office')`; `CHECK (doc_type <> 'advance_invoice' OR channel = 'office')` |
| branch_id | bigint → sys.branches | |
| business_line_id | bigint → md.business_lines | POS default = supplies |
| warehouse_id | bigint → md.warehouses | |
| device_id | bigint → auth.devices | |
| register_id | bigint? → cash.registers | |
| shift_id | bigint? → cash.shifts | `CHECK (channel <> 'pos' OR shift_id IS NOT NULL)`. Trigger: the creating user is the shift's cashier and the shift is open ([0004](decisions/0004-one-cashier-per-drawer-shift.md)). |
| pos_cart_id | uuid? | Links the cart-removal audit events ([0005](decisions/0005-cart-removals-logged-without-approval.md)) |
| customer_id | bigint → md.customers | |
| bill_to_name | text | Snapshot at issue |
| bill_to_name_alt, bill_to_trn, bill_to_address, bill_to_phone | text? | Snapshot; the TRN is copied only if the customer is VAT-registered; a full tax invoice needs the address (taken from the customer at issue when empty, refused when there is none, decision 0064) |
| customer_po | text? | Customer PO number, up to 50 characters (decision 0066) |
| seller_snapshot | jsonb? | |
| issue_date | date? | |
| supply_date | date? | |
| issued_at | timestamptz? | |
| due_date | date? | `>= issue_date` |
| currency | char(3) | `'AED'` |
| price_level_id | bigint? → md.price_levels | NULL for `advance_invoice` ([0032](decisions/0032-one-sale-price-with-vat-flag-and-customer-types.md)) |
| salesperson_id | bigint? → auth.users | |
| quotation_id | bigint? → sales.quotations | Agreement that invoices and payment invoices belong to |
| original_document_id | bigint? → sales.documents | `CHECK ((doc_type IN ('credit_note','debit_note')) = (original_document_id IS NOT NULL))`; the original must be an issued `invoice` or `advance_invoice` of the same customer |
| reason_code_id | bigint? → sys.reason_codes | |
| reason_text | text? | Required for notes |
| approval_id | bigint? → auth.approvals | A discount above the limit or a credit note; a price approval is never taken as a discount approval (migration 0018) |
| discount_total_fils | bigint | `>= 0`; Σ line discounts (price basis) |
| net_fils | bigint | `>= 0`; Σ line net (deductions included) |
| vat_fils | bigint | `>= 0`; Σ line VAT (deductions included) |
| total_fils | bigint | `CHECK (total_fils = net_fils + vat_fils)` |
| cost_fils | bigint | `DEFAULT 0` |
| settled_fils | bigint | `DEFAULT 0`, `0..total_fils`; maintained by triggers |
| settlement_status | text | `CHECK IN ('open','partial','settled')` |
| advance_used_net_fils | bigint | `DEFAULT 0`. `advance_invoice` only: net already deducted by final invoices or reversed by credit notes; `<= net_fils` |
| advance_used_vat_fils | bigint | `DEFAULT 0`; `<= vat_fils` |
| content_hash | bytea? | SHA-256 of the canonical issued content |
| print_count | integer | `DEFAULT 0` |
| notes, internal_note | text? | |
| issued_by | bigint? → auth.users | |
| [std] | | |

**Checks:**
- `CHECK (doc_type = 'advance_invoice' OR (advance_used_net_fils = 0 AND advance_used_vat_fils = 0))`
- **Draft or discarded:** no number.
- **Issued:** number, dates, `issued_by`, `content_hash` and `seller_snapshot` are all required.

**After issue, only these may change:** `settled_fils`, `settlement_status`, `advance_used_*`, `print_count` and the update stamps. The issue date must be in an open period.

### 9.4 `sales.document_lines` (frozen once the parent is issued; DELETE only while draft)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| document_id | bigint → sales.documents | `UNIQUE (document_id, line_no)` |
| line_no | smallint | |
| line_kind | text | `CHECK IN ('item','advance','advance_deduction')`. `advance` only on `advance_invoice`; `advance_deduction` only on `invoice`. |
| item_id | bigint? → md.items | `CHECK ((line_kind = 'item') = (item_id IS NOT NULL))` |
| item_type | text? | Snapshot |
| description_ar, description_en | text | Snapshot (bilingual print) |
| unit_id | bigint? → md.units | |
| business_line_id | bigint → md.business_lines | Item default, else the document's |
| quantity | numeric(14,3) | `> 0`; `= 1` for `advance` / `advance_deduction` |
| list_price_4dp | bigint | Item price at the document's price level (item lines) |
| price_includes_vat | boolean | Snapshot of the item price's "includes VAT" switch ([0032](decisions/0032-one-sale-price-with-vat-flag-and-customer-types.md)); always `true` on `advance` lines (the amount received includes VAT). Each line follows its own switch. |
| unit_price_4dp | bigint | Price charged ("original price"). `CHECK (unit_price_4dp >= 0 OR line_kind = 'advance_deduction')` |
| price_override_approval_id | bigint? → auth.approvals | When `unit_price ≠ list_price` without `sales.price_override` |
| amount_before_discount_fils | bigint | `round_fils(qty × unit_price_4dp)` |
| line_discount_bp | integer? | If entered as % |
| line_discount_fils | bigint | `>= 0` |
| doc_discount_alloc_fils | bigint | `>= 0`; share of the document discount (largest remainder) |
| discount_excl_vat_fils | bigint | `>= 0`; total line discount expressed excl. VAT (for reports) ([0012](decisions/0012-discounts-net-revenue-per-line.md)) |
| net_fils | bigint | Taxable amount |
| vat_category_id | bigint → md.vat_categories | |
| vat_category_code | text | Snapshot |
| vat_rate_bp | integer | Snapshot |
| vat_fils | bigint | Per line ([0009](decisions/0009-vat-per-line.md)) |
| gross_fils | bigint | `CHECK (gross_fils = net_fils + vat_fils)` |
| cost_fils | bigint | `DEFAULT 0`; from the movements at issue |
| advance_document_id | bigint? → sales.documents | `CHECK ((line_kind = 'advance_deduction') = (advance_document_id IS NOT NULL))` |
| original_line_id | bigint? → sales.document_lines | Notes; Σ credited qty ≤ original qty |
| return_stock_status | text? | Credit notes: `available` / `defective` / NULL (no goods back) |
| technician_id | bigint? → md.technicians | |
| note | text? | |

**Sign checks:**
- `item` and `advance` lines: all amounts `>= 0`.
- `advance_deduction` lines: `net_fils <= 0 AND vat_fils <= 0`, discounts 0.

**Trigger on deductions:**
- The deducted document is an issued `advance_invoice` of the same customer.
- Its `advance_used_*` is increased.
- The deduction never exceeds the remaining net or VAT.

### 9.5 `sales.payments` (receipts, refunds, reversals; append-only)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| uuid | uuid | |
| payment_kind | text | `CHECK IN ('receipt','refund','reversal')` |
| direction | text | `CHECK IN ('in','out')` |
| status | text | `CHECK IN ('posted','reversed')` |
| reversal_of_id | bigint? → sales.payments | unique; `CHECK ((payment_kind = 'reversal') = (reversal_of_id IS NOT NULL))` |
| series_id | bigint → sys.document_series | `RCT-` / `RFD-` / `RVS-` |
| seq_no | bigint | `UNIQUE (series_id, seq_no)` |
| doc_number | text | |
| customer_id | bigint → md.customers | |
| payment_method_id | bigint → md.payment_methods | |
| method_kind | text | Snapshot |
| amount_fils | bigint | `> 0` |
| tendered_fils, change_fils | bigint? | Cash only; `tendered − change = amount` |
| reference | text? | Card last 4 + auth code, cheque no., transfer ref (never a full card number) |
| cheque_date | date? | |
| cheque_bank | text? | |
| payment_date | date | |
| received_at | timestamptz | |
| channel | text | `pos` / `office` |
| device_id | bigint → auth.devices | |
| register_id | bigint? → cash.registers | |
| shift_id | bigint? → cash.shifts | Required for POS cash; cashier must own the shift |
| allocated_fils | bigint | `DEFAULT 0`, `0..amount_fils` |
| approval_id | bigint? → auth.approvals | Refunds, reversals |
| notes | text? | |
| [ins] | | |

**Deferred check at commit:** `allocated_fils = amount_fils`. **Money is never left unallocated:** any part of a receipt that does not settle an issued tax invoice becomes an advance/progress payment with its own `advance_invoice`, in the same transaction ([0013](decisions/0013-advance-and-progress-payments-vat.md)).

**Reversing a receipt that created an advance invoice** also issues a credit note against that advance invoice, in the same operation.

### 9.6 `sales.payment_allocations` (append-only)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| payment_id | bigint → sales.payments | |
| document_id | bigint? → sales.documents | Receipt → `invoice` / `advance_invoice` / `debit_note`; refund → `credit_note`; reversal → the documents the reversed payment settled |
| opening_balance_id | bigint? → sales.opening_balances | |
| amount_fils | bigint | `> 0` |
| [ins] | | |

**Checks:**
- `num_nonnulls(document_id, opening_balance_id) = 1`.
- Trigger: same customer, issued target, matching direction, limits respected. It updates the payment's `allocated_fils` and the target's settlement (a reversal reduces it).

### 9.7 `sales.credit_allocations` (append-only)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| credit_note_id | bigint → sales.documents | Issued `credit_note` |
| invoice_id | bigint? → sales.documents | |
| opening_balance_id | bigint? → sales.opening_balances | |
| amount_fils | bigint | `> 0` |
| [ins] | | |

**Checks:** one target; same customer; limits. A credit note against an unpaid invoice is applied to it automatically. Any excess is refunded or kept as customer credit.

### 9.8 `sales.opening_balances` (append-only)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| customer_id | bigint → md.customers | |
| balance_date | date | Go-live date |
| direction | text | `CHECK IN ('receivable','payable')` |
| amount_fils | bigint | `> 0` |
| reference | text? | |
| due_date | date? | |
| settled_fils | bigint | `0..amount_fils` |
| import_batch_id | bigint? → sys.import_batches | |
| [ins] | | |

### 9.9 `sales.held_carts`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| cart_id | uuid | Same cart ID as the removal events |
| device_id | bigint → auth.devices | |
| register_id | bigint? → cash.registers | |
| user_id | bigint → auth.users | |
| customer_id | bigint? → md.customers | |
| label | text? | |
| cart | jsonb | Re-priced and re-validated on resume |
| status | text | `CHECK IN ('held','resumed','discarded')` |
| held_at | timestamptz | |
| closed_at | timestamptz? | |
| closed_by | bigint? → auth.users | |

---

## 10. Schema `cash`

### 10.1 `cash.registers`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique |
| name_ar, name_en | text | |
| branch_id | bigint → sys.branches | |
| device_id | bigint? → auth.devices | unique |
| warehouse_id | bigint → md.warehouses | |
| invoice_series_id | bigint → sys.document_series | Must be the `pos`-channel invoice series (`POS-`) |
| receipt_series_id | bigint → sys.document_series | |
| drop_threshold_fils | bigint | `> 0` |
| variance_approval_threshold_fils | bigint | `>= 0` |
| drawer_status_supported | boolean | |
| [active], [std] | | |

### 10.2 `cash.shifts` (immutable once closed)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| uuid | uuid | |
| series_id | bigint → sys.document_series | `Z-` |
| seq_no | bigint | `UNIQUE (series_id, seq_no)` |
| shift_number | text | |
| register_id | bigint → cash.registers | Partial unique `WHERE status = 'open'` |
| cashier_id | bigint → auth.users | **Responsible cashier**; partial unique `WHERE status = 'open'` ([0004](decisions/0004-one-cashier-per-drawer-shift.md)) |
| status | text | `CHECK IN ('open','closed')` |
| opened_at | timestamptz | |
| opened_by | bigint → auth.users | `CHECK (opened_by = cashier_id)` |
| opening_float_fils | bigint | `>= 0` |
| opening_count_id | bigint? → cash.counts | |
| closed_at | timestamptz? | |
| closed_by | bigint? → auth.users | |
| closing_count_id | bigint? → cash.counts | The **final** count (the recount, if one was made) |
| expected_cash_fils | bigint? | Float + cash sales − cash refunds + paid-in − paid-out − drops + top-ups |
| counted_cash_fils | bigint? | From the final count |
| variance_fils | bigint? | `= counted − expected` |
| variance_reason_code_id | bigint? → sys.reason_codes | |
| variance_note | text? | |
| approval_id | bigint? → auth.approvals | Accepting a variance above threshold |
| z_snapshot | jsonb? | Frozen totals per tender, VAT, discounts, refunds, no-sales, paid-in/out, drops, **both counts** |
| force_closed_by | bigint? → auth.users | Closed from another PC as a stuck shift; set once by someone with `shifts.force_close` ([0069](decisions/0069-stuck-shifts.md)) |
| force_close_reason | text? | Required with `force_closed_by` |
| audit_anchor_seq | bigint? | |
| audit_anchor_hash | bytea? | |
| [std] | | |

**Closed check:** when closed, the close columns are all NOT NULL (one `CHECK` using `num_nulls`).

### 10.3 `cash.counts` (append-only)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| shift_id | bigint → cash.shifts | |
| purpose | text | `CHECK IN ('opening','closing','drop','spot_check')` |
| total_fils | bigint | `>= 0`; deferred check = Σ lines |
| supersedes_id | bigint? → cash.counts | Set on a **recount** |
| approval_id | bigint? → auth.approvals | `CHECK (supersedes_id IS NULL OR approval_id IS NOT NULL)`: recount needs supervisor approval ([0006](decisions/0006-one-recount-with-supervisor-approval.md)) |
| counted_by | bigint → auth.users | |
| counted_at | timestamptz | |

**At most one count and one recount per shift:**
- partial unique `(shift_id) WHERE purpose = 'closing' AND supersedes_id IS NULL`
- partial unique `(shift_id) WHERE purpose = 'closing' AND supersedes_id IS NOT NULL`

### 10.4 `cash.count_lines` (append-only)

| Column | Type | Rules |
|---|---|---|
| count_id | bigint → cash.counts | PK part |
| denomination_id | bigint → md.cash_denominations | PK part |
| quantity | integer | `>= 0` |
| amount_fils | bigint | Trigger: `= value × quantity` |

### 10.5 `cash.movements` (append-only, migration 0022)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| uuid | uuid | |
| series_id | bigint → sys.document_series | `CV-`; `UNIQUE (series_id, seq_no)` |
| seq_no | bigint | |
| voucher_number | text | |
| shift_id | bigint → cash.shifts | Open; the user must be its cashier (`cash.assert_shift_owner`) |
| register_id | bigint → cash.registers | From the shift |
| device_id | bigint? → auth.devices | From the request context |
| movement_type | text | `CHECK IN ('opening_float','paid_in','paid_out','cash_drop','float_top_up','closing_transfer')`; the opening float and the closing transfer once per shift |
| direction | text | `in` (opening float, paid-in, top-up) / `out` (the rest), set by the trigger |
| amount_fils | bigint | `> 0`; money out never above `cash.expected_cash()` (except the closing transfer) |
| movement_date | date | Business date; the month must be open |
| reason_code_id | bigint? → sys.reason_codes | Required for paid-in / paid-out, of that category (the reason names the account, rows 16–17) |
| note | text? | |
| counterparty | text? | |
| approval_id | bigint? → auth.approvals | A paid-out needs `cash.paid_out` or an approval for it |
| drop_count_id | bigint? → cash.counts | Drops only; a `drop` count of the same shift for the same amount |
| [ins] | | |

At commit, every movement has its journal entry (posting map rows 16–18).

`cash.expected_cash(shift)` = cash payments on the shift (in − out, net of change) + movements (in − out), the closing transfer left out.

**Close** (`cash.shift_close_rules`): the shift must have a closing count; the recount, when there is one, is the final count. The database sets `closing_count_id`, `counted_cash_fils`, `expected_cash_fils` and `variance_fils`; a counted amount above zero needs the closing transfer in the same transaction. **Open**: an opening float above zero needs the `opening_float` movement in the same transaction.

**Counts** (0022): `other_amount_fils` (≥ 0) for cash that is not a listed denomination ([0056](decisions/0056-cash-count-denominations.md)); total = lines + other amount. Only the open shift's cashier counts; a recount replaces the closing count once, with a `shifts.recount` approval.

### 10.6 `cash.drawer_events` (append-only)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| register_id | bigint → cash.registers | From the shift when there is one |
| shift_id | bigint? → cash.shifts | Its own cashier only |
| event_type | text | `CHECK IN ('open_sale','open_payment','open_cash_movement','open_count','open_no_sale','reported_open','reported_closed','left_open_alert')` |
| sales_document_id | bigint? → sales.documents | |
| payment_id | bigint? → sales.payments | |
| cash_movement_id | bigint? → cash.movements | |
| reason_code_id | bigint? → sys.reason_codes | Required for `open_no_sale`, category `no_sale`; the user needs `pos.no_sale` |
| note | text? | |
| approval_id | bigint? → auth.approvals | |
| user_id | bigint → auth.users | The signed-in user |
| device_id | bigint? → auth.devices | From the request context |
| occurred_at | timestamptz | |

### 10.7 `cash.variance_acceptances` (append-only, decision 0058)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| shift_id | bigint → cash.shifts | `UNIQUE`; the shift must be closed |
| variance_fils | bigint | Copied from the shift by the trigger |
| reason_code_id | bigint? → sys.reason_codes | |
| note | text? | 3–1000 characters |
| accepted_at / accepted_by | | Stamped; needs `cash.variance_accept`; never the shift's own cashier |

At commit, a non-zero accepted variance has its `shift_close` journal entry (row 19).

---

## 11. Schema `gl` (postings from P1)

### 11.1 `gl.accounts`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique |
| name_ar, name_en | text | |
| account_type | text | `CHECK IN ('asset','liability','equity','revenue','expense')`; fixed after the first posting |
| parent_id | bigint? → gl.accounts | |
| is_postable | boolean | Headers are not postable |
| is_control | boolean | Lines on it must carry `customer_id` (or `supplier_id` from P2) |
| is_contra | boolean | e.g. accumulated depreciation |
| [active], [std] | | Cannot be deactivated while mapped or holding a balance |

The provisional chart is in [`accounting/chart-of-accounts.md`](accounting/chart-of-accounts.md) (**pending accountant review**).

### 11.2 `gl.account_mappings`

| Column | Type | Rules |
|---|---|---|
| key | text PK | `CHECK IN ('ar_control','ap_control','customer_advances','vat_output','vat_input','inventory','inventory_defective','stock_adjustments','write_off','cash_over_short','cash_in_safe','opening_balance_equity')` |
| account_id | bigint → gl.accounts | |
| updated_at, updated_by, row_version | | |

Revenue and cost of sales come from `md.business_lines`, payment accounts from `md.payment_methods`, and paid-in/out accounts from `sys.reason_codes`. **There is no discount account:** revenue is posted net ([0012](decisions/0012-discounts-net-revenue-per-line.md)).

### 11.3 `gl.periods` (monthly)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| period_start | date | unique; first day of a month |
| period_end | date | Last day of the same month; `EXCLUDE USING gist (daterange(period_start, period_end, '[]') WITH &&)` |
| fiscal_year | smallint | |
| status | text | `CHECK IN ('open','closed','locked')` |
| closed_at | timestamptz? | |
| closed_by | bigint? → auth.users | |
| locked_at | timestamptz? | |
| locked_by | bigint? → auth.users | |
| [std] | | |

**Status rules:**
- Open → closed → locked, one step at a time, in month order. A month closes only after it ends; reopening a closed month needs a reason; who and when are stamped by the database.
- `closed` and `locked` both reject every posting and every document issue ([0016](decisions/0016-monthly-period-lock.md)).
- `locked` can never be reopened.

### 11.4 `gl.journal_entries` (append-only)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| uuid | uuid | |
| series_id | bigint → sys.document_series | `JV-`; `UNIQUE (series_id, seq_no)` |
| seq_no | bigint | |
| entry_number | text | |
| entry_date | date | |
| period_id | bigint → gl.periods | Contains the date; must be `open` |
| source_type | text | `CHECK IN ('sales_document','payment','opening_balance','cash_movement','shift_close','inventory_adjustment','inventory_count','reversal','manual')` |
| sales_document_id | bigint? → sales.documents | |
| payment_id | bigint? → sales.payments | |
| opening_balance_id | bigint? → sales.opening_balances | |
| cash_movement_id | bigint? → cash.movements | |
| shift_id | bigint? → cash.shifts | |
| inventory_adjustment_id | bigint? → inv.adjustments | |
| inventory_count_id | bigint? → inv.counts | |
| reversal_of_id | bigint? → gl.journal_entries | unique |
| memo | text? | |
| total_debit_fils | bigint | `CHECK (total_debit_fils = total_credit_fils AND total_debit_fils > 0)` |
| total_credit_fils | bigint | |
| posted_at | timestamptz | |
| posted_by | bigint → auth.users | |

**Checks:**
- Exactly one source column matches `source_type`.
- Partial unique per source column (`WHERE source_type <> 'reversal'`): **a document can never be posted twice**.

### 11.5 `gl.journal_lines` (append-only)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| entry_id | bigint → gl.journal_entries | `UNIQUE (entry_id, line_no)` |
| line_no | smallint | |
| account_id | bigint → gl.accounts | Postable, active |
| debit_fils, credit_fils | bigint | `>= 0`; `CHECK ((debit_fils = 0) <> (credit_fils = 0))` |
| customer_id | bigint? → md.customers | Required on control accounts |
| business_line_id | bigint? → md.business_lines | Reporting dimension (revenue, cost of sales) |
| vat_category_id | bigint? → md.vat_categories | On VAT lines |
| memo | text? | |

**Deferred trigger at commit:** Σ debit = Σ credit = the header totals, and at least 2 lines.

### 11.6 Posting rules

See the one-page [posting map](accounting/posting-map.md) (**pending accountant review**). It is implemented as a table-driven posting engine in `apps/server/src/modules/ledger`. Mapped accounts are read from data, never hard-coded.

---

## 12. Schema `ops`

### 12.1 `ops.outbox`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| uuid | uuid | |
| channel | text | `CHECK IN ('einvoice','email','whatsapp')` |
| sales_document_id | bigint? → sales.documents | Partial unique `WHERE channel = 'einvoice'` |
| status | text | `CHECK IN ('not_required','pending','sending','sent','accepted','rejected','failed','cancelled')` |
| payload_format | text? | |
| payload | jsonb? | Immutable once set |
| payload_sha256 | bytea? | |
| attempts | integer | `DEFAULT 0` |
| next_attempt_at, last_attempt_at | timestamptz? | |
| last_error | text? | |
| provider_reference | text? | |
| response | jsonb? | |
| created_at, updated_at | timestamptz | |

**P1:** a row is written for every issued tax document: `not_required` before `einvoice.mandatory_from`, `pending` after it ([0019](decisions/0019-einvoicing-via-accredited-provider.md)).

### 12.2 `ops.backup_runs` (migration 0036)

Every local copy, off-site upload, external-drive copy and restore test ([0086](decisions/0086-backups-local-and-google-drive.md)). Written by the backup service as the SYSTEM user; final once finished; audited; never deleted.

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| kind | text | `CHECK IN ('wal_archive','base_backup','logical_dump','offsite_upload','offline_copy','restore_test')` |
| status | text | `CHECK IN ('running','success','failed')`; `finished_at` set exactly when not running; a failure needs `error_message` |
| request_id | bigint? → ops.backup_requests | When the owner asked for it |
| started_at, finished_at | timestamptz | |
| target, file_name | text? | A folder, `google_drive` or the restore database; never credentials |
| size_bytes | bigint? | |
| sha256 | bytea? | 32 bytes |
| encrypted | boolean | `true` for off-site copies (age) |
| audit_chain_seq, audit_chain_hash | bigint?, bytea? | The chain head when the copy was taken (also an `audit.anchors` row of kind `backup`) |
| details | jsonb? | E.g. the Drive file id, the source copy |
| error_message | text? | ≤ 2000 characters |
| [upd] | | |

### 12.3 `ops.integrity_runs` (migration 0036)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| run_kind | text | `CHECK IN ('nightly','restore_test','manual','after_start')` (`after_start`: once after every database start, migration 0047, decision 0111) |
| database_name | text | The live database or the throwaway restore database |
| backup_run_id | bigint? → ops.backup_runs | For a restore test |
| started_at, finished_at | timestamptz | |
| status | text | `CHECK IN ('running','ok','issues','error')` |
| results | jsonb | One entry per check: `{ ok, problems, examples }` for `audit_chain`, `journals_balanced`, `trial_balance`, `stock_vs_ledger`, `numbering_gaps` (more checks may be added) |
| [upd] | | |

### 12.4 `ops.backup_requests` (migration 0036)

The owner asks the backup service for something now. Inserted by the API (owner only, enforced by a trigger, `AP010`); moved forward by the backup service only: `pending → running → done/failed`; one open request per kind (partial unique index).

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| kind | text | `CHECK IN ('backup_now','offsite_now','restore_test','offline_copy')` |
| target | text? | The external drive's folder, `offline_copy` only |
| status | text | `CHECK IN ('pending','running','done','failed')` |
| error_message | text? | |
| [upd] | | |

---

### 12.5 `ops.update_state` (migration 0044, decision 0108)

One row (`id = 1`) kept by the server PC's updater (as `artepool_backup`, SYSTEM context) and shown in System health.

| Column | Type | Notes |
|---|---|---|
| current_version | text? | The version running (x.y.z) |
| checked_at / check_error | timestamptz? / text? | Last read of the public update list; why it failed (no internet is normal) |
| check_requested_at | timestamptz? | The owner's last "Check now" (migration 0046, decision 0110; owner-only guard, the API may set only this and the window): the updater reads the list on its next run when this is newer than `checked_at` |
| available_version, notes_ar, notes_en, published_at | text? … | The newest published version and its release notes (null when up to date; cleared as soon as that version is running) |
| download_status | text | `none`, `downloading`, `ready` (SHA-256 and signature checked), `failed` |
| waiting_reason | text? | `open_shift`, `outside_window`, `failed_before` (rolled back once; waits for "Install now"), `installing` |
| last_result | jsonb? | The setup's `updates\last-result.json`: ok, from, to, at, failed step |
| window_start_hour / window_end_hour | smallint | Night window in Asia/Dubai hours (default 2–5); owner editable |

### 12.6 `ops.update_requests` (migration 0044, decision 0108)

The owner's "Install now" (`system.update.manage`, owner only): `version`, `status` (`pending` → `running` → `done`/`failed`, forward only; one open at a time), `error_message`. Audited, never deleted.

### 12.7 `ops.server_health` (migration 0045, M6.2 part H)

One row (`id = 1`), audited, never deleted; shown on System health → "Server PC" (owner only).

| Column | Type | Notes |
|---|---|---|
| ups_confirmed_at | timestamptz? | The owner confirmed a UPS is connected (`system.health.manage`; a trigger lets only the owner change it). Asked again after 182 days |
| cert_expires_at | timestamptz? | The server certificate in use, as the updater last saw it |
| cert_renewed_at | timestamptz? | The last automatic renewal that was checked and switched to (60 days before the end; the audit log keeps the old and new expiry of each) |
| cert_renew_attempted_at / cert_renew_error | timestamptz? / text? | The last try and why it failed (tried again the next night) |

The API may update only `ups_confirmed_at`; the updater (`artepool_backup`) only the certificate columns. Disks, the backup service heartbeat (`backups\.heartbeat`, a file), WAL archiving (`pg_stat_archiver`) and the certificates' dates are read live, not stored.

## 13. Views

| View | Purpose |
|---|---|
| `inv.stock_on_hand_v` | Item × warehouse × status: quantity, value, average cost (4 dp) |
| `inv.low_stock_v` | At or below the reorder level |
| `inv.movement_history_v` | Movements with document numbers, users and running balance |
| `inv.oversell_review_v` | Oversell adjustments `pending` review, with the sale, cashier and approver |
| `sales.customer_ledger_v` | Statement of account: invoices, payment invoices and debit notes (debit); credit notes and receipts (credit); refunds and reversals (debit); opening balances |
| `sales.open_items_v` | Unsettled invoices and opening balances with days overdue |
| `sales.advance_balances_v` | Payment invoices with the net and VAT still available to deduct |
| `sales.vat_summary_v` | Per month × VAT category: net and VAT from invoices, payment invoices and debit notes (+) and credit notes (−), including deduction lines |
| `sales.discounts_v` | Discounts given per day / line of business / user (from the lines) |
| `cash.shift_summary_v` | Live X-report figures (never shown to a cashier before the blind count) |
| `audit.log_v` | Audit log with user and device names |

---

## 14. Functions and triggers

| Function | Kind | Purpose |
|---|---|---|
| `sys.set_context(…)` | function | Transaction-local user/device/session/request/reason/approval context |
| `sys.business_date(ts)` | immutable | Dubai date |
| `sys.normalize_search(text)` | immutable | Arabic/English search normalization |
| `sys.round_div(num, den)` | immutable | Integer division rounded half away from zero, at any scale. `round_fils(x)` in this document means "round to the fils with this helper". **Same test vectors as the TypeScript helper.** |
| `sys.next_number(series_id)` | security definer | Gapless number |
| `sys.touch_row()` | trigger | `updated_*`, `row_version` |
| `sys.guard_immutable()` | trigger | Per-table whitelist of columns that may change after issue/post/close |
| `sys.guard_no_delete()` | trigger | Rejects DELETE except on the allowed tables |
| `sys.guard_draft_lines()` | trigger | Lines change only while the parent is a draft |
| `sys.check_series_channel()` | trigger | Document type/channel ↔ series type/channel |
| `cash.check_shift_owner()` | trigger | POS documents, POS payments and cash movements: creator = cashier of the open shift |
| `audit.capture_row()` | trigger, security definer | Row audit; redaction; rejects writes without context |
| `audit.record_event(…)` | security definer | Explicit events (cart removals, prints, exports, …) |
| `audit.seal_transaction()` | deferred constraint trigger | Hash chain at commit |
| `audit.verify_chain(from, to)` | function | Recompute and compare with anchors |
| `audit.add_anchor(kind, ref)` | security definer | Records the chain head |
| `inv.apply_movement()` | trigger, security definer | Lock, cost, block negative, update balance and average |
| `sales.apply_allocation()` | trigger | Allocation rules; settlement updates (reversals reduce) |
| `sales.check_payment_allocated()` | deferred constraint trigger | Receipts and refunds fully allocated at commit |
| `sales.apply_advance_deduction()` | trigger | Deduction rules; `advance_used_*` updates |
| `sales.check_note_quantities()` | trigger | Notes ≤ original quantities / remaining advance |
| `gl.check_entry_balanced()` | deferred constraint trigger | Balanced, ≥ 2 lines |
| `gl.check_period_open()` | trigger | Journal entries, document issue, stock and cash postings |
| `sys.clock_guard()` | trigger on `audit.log`, security definer | Refuses any write (every write is audited) whose server time is more than 2 minutes (`sys.clock_tolerance()`) before the latest audit row: `CLOCK_BACKWARDS`. Checked once per transaction. Only the `clock_backwards` alert itself gets through (migration 0043) |
| `sys.clock_status()` | security definer | Server time, latest record, behind or not: the server checks it every 5 minutes and raises one critical `clock_backwards` alert per day |
| `sys.require_reason_to_deactivate()` | trigger | Deactivating master data or an account needs a reason in the request context ([0037](decisions/0037-master-data-defaults.md)) |
| `gl.account_in_use(id)` | function | Why an account is in use (event link, line of business, payment method, reason code; postings from 0011), or NULL |
| `gl.ensure_periods(n)` | security definer | Creates the missing months up to n months ahead ([0035](decisions/0035-fiscal-year-and-provisional-chart.md)) |
| `md.item_in_use(id)` | function | Why an item is in use (kit component or kit contents; movements and document lines later), or NULL |
| `sys.check_setting()` | trigger | Safe whole-number ranges for every `security.*` setting (password length never below 10); `client.min_version` format |
| `auth.user_has_permission(user, code)` | function | Active user + active role + role permission |
| `auth.assert_single_owner()` | function | At most one active owner (advisory lock) |
| `auth.check_two_step()` | deferred constraint trigger | Roles with `requires_2fa` ⇒ `password_totp` users |
| `auth.session_before_insert()` | trigger | Sign-in rules of decision 0021 |
| `auth.approval_before_insert()` / `auth.guard_approval()` | triggers | Approval rules (context, expiry, single use) |

---

## 15. Reference and seed data

### 15.1 Permissions

| Module | Codes |
|---|---|
| system | `system.company.edit`, `system.settings.edit`, `system.series.manage`, `system.devices.manage`, `system.health.view`, `system.backup.restore_test`, `system.integrity.run`, `system.backup.manage` (the last four owner only, 0036) |
| users | `users.view`, `users.manage`, `users.reset_credentials`, `roles.manage` |
| audit | `audit.view`, `audit.verify`, `audit.export` |
| master data | `items.view`, `items.manage`, `prices.manage`, `customers.view`, `customers.manage`, `customers.credit`*, `suppliers.manage`, `technicians.manage`, `payment_methods.manage`, `warehouses.manage`, `data.import` |
| inventory | `stock.view`, `stock.view_cost`, `stock.adjust`, `stock.adjust_over_threshold`*, `stock.count`, `stock.count_post`, `stock.defective`, `stock.write_off`, `stock.oversell_review`, `labels.print` |
| sales (A4) | `invoices.view`, `quotations.manage`, `invoices.create`, `invoices.issue`, `sales.discount_over_limit`*, `sales.price_override`*, `sales.credit_over_limit`*, `credit_notes.issue`*, `debit_notes.issue`, `payments.receive`, `payments.refund`*, `payments.reverse`*, `statements.view`, `documents.reprint` |
| pos | `pos.sell`, `pos.oversell`*, `pos.no_sale` |
| cash | `shifts.open`, `shifts.close`, `shifts.recount`*, `shifts.view_all`, `cash.paid_in`, `cash.paid_out`*, `cash.drop`, `cash.variance_accept`*, `reports.x` |
| ledger | `ledger.view`, `accounts.manage`, `periods.manage` |
| export | `data.export` |

\* = approvable (supervisor PIN + reason, single use). There is no cart-removal permission: removals are always allowed and logged ([0005](decisions/0005-cart-removals-logged-without-approval.md)).

**Default roles (editable):**

| Role | Permissions |
|---|---|
| **Owner** | All; 2FA required |
| **Accountant** | All except users, roles, devices, system settings and company details (owner-only, [0030](decisions/0030-company-details-owner-only.md)); keeps viewing, verifying and exporting the audit log |
| **Cashier** | `pos.sell`, `payments.receive`, `shifts.open` / `close`, `cash.drop`, `cash.paid_in`, `reports.x`, `items.view`, `customers.view` / `manage`, `labels.print`, `invoices.view`, `documents.reprint` |
| **Storekeeper** | `stock.*` except `stock.view_cost`, plus `items.view`, `labels.print` |
| **Technician** | `items.view`, `customers.view` |

Discount limits start at 0 for every role except Owner.

### 15.2 Document series

| Code | Type | Channel | Prefix |
|---|---|---|---|
| POS | invoice (POS sales) | pos | `POS-` |
| INV | invoice + advance_invoice (A4) | office | `INV-` |
| CN | credit_note | — | `CN-` |
| DN | debit_note | — | `DN-` |
| Q | quotation | — | `Q-` |
| RCT | receipt | — | `RCT-` |
| RFD | refund | — | `RFD-` |
| RVS | payment_reversal | — | `RVS-` |
| CV | cash_voucher | — | `CV-` |
| Z | shift | — | `Z-` |
| ADJ | stock_adjustment | — | `ADJ-` |
| CNT | stock_count | — | `CNT-` |
| JV | journal | — | `JV-` |

All series use 6 digits and continuous numbering ([0011](decisions/0011-document-numbering-series.md)).

### 15.3 Other seeds

- **VAT categories:** `SR` 5%, `ZR` 0%, `EX`, `OS`.
- **Units:** `PCS`, `BOX`, `BAG`, `BTL`, `SET` (0 decimals), `KG`, `L` (3), `M`, `M2`, `HR` (2), `VISIT`, `JOB` (0). E-invoice codes only where certain (`H87`, `KGM`, `LTR`, `MTR`, `MTK`, `HUR`).
- **Item categories:** `CHEM` Chemicals, `EQUIP` Equipment, `CLEAN` Cleaning, `PARTS` Spare parts, `SERV` Services.
- **Lines of business:** supplies (4100/5100), construction (4200/5200), maintenance (4300/5300), cleaning (4400/5400).
- **Chart of accounts and mappings:** the provisional chart from [`accounting/chart-of-accounts.md`](accounting/chart-of-accounts.md).
- **Payment methods:** Cash (1110), Card (1150), Bank transfer (1140), Cheque (1160).
- **AED denominations:** notes 1000–5; coins 1 AED, 50 fils, 25 fils.
- **Branch and warehouse:** branch `HQ` (Al Ain); warehouse `MAIN`.
- **Price level:** `STANDARD` (default; no customer types) ([0032](decisions/0032-one-sale-price-with-vat-flag-and-customer-types.md)).
- **Walk-in customer:** "عميل نقدي / Cash customer" (type individual, not VAT-registered, cash).
- **Periods:** monthly periods from January of the current year (fiscal year January–December, [0035](decisions/0035-fiscal-year-and-provisional-chart.md)) up to 3 months ahead; the server keeps creating them 3 months ahead.
- **Reason codes:**
  - stock: damaged, expired, found, theft/loss, data correction, oversell
  - defective: customer return – broken
  - credit note: return, price adjustment, invoice error, wrong invoice format
  - payment reversal: bounced cheque
  - cash: change float, petty expense, owner withdrawal, bank deposit
  - other: no sale (give change, check drawer); recount (miscount); reprint (customer request)
- **Users:** the SYSTEM user, and the first Owner account (created by the installer; must change its password and set up TOTP at first login).

### 15.4 Settings

| Key | Default | Note |
|---|---|---|
| `locale.default_language` | `"ar"` | |
| `locale.digits` | `"latn"` | Western 0-9 |
| `locale.date_format` | `"dd/MM/yyyy"` | |
| `security.max_failed_logins` / `security.lockout_minutes` | `5` / `15` | |
| `security.idle_lock_minutes.office` / `.pos` | `15` / `5` | |
| `security.session_max_hours` | `12` | |
| `security.approval_validity_seconds` | `300` | |
| `security.max_failed_pins` | `5` | PIN blocked until the owner unblocks it ([0021](decisions/0021-cashier-pin-sign-in-on-pos-pcs.md)) |
| `security.password_min_length` | `10` | Never below 10 ([0023](decisions/0023-password-rules.md)) |
| `security.enrollment_code_minutes` / `security.enrollment_max_attempts` | `10` / `5` | [0024](decisions/0024-device-enrollment-proves-the-server.md) |
| `security.device_key_days` | `365` | Device keys renew themselves before expiry |
| `client.min_version` | `"0.1.0"` | Oldest desktop app allowed to connect |
| `clock.max_client_skew_seconds` | `120` | |
| `pos.out_of_stock_mode` | `"allow_with_approval"` | [0003](decisions/0003-pos-oversell-with-approval.md) |
| `pos.default_business_line` | `"supplies"` | |
| `print.pos_receipt_auto` | `true` | Silent thermal printing ([0008](decisions/0008-printing-pos-silent-a4-section.md)) |
| `print.receipt_language` | `"both"` | |
| `print.mark_reprints_as_copy` | `true` | |
| `inventory.adjustment_approval_threshold_fils` | `50000` | 500 AED; adjustable |
| `cash.variance_alert_repeat_count` | `3` | Variances above `cash.variance_alert_fils` within `cash.variance_alert_days` ([0058](decisions/0058-shift-variance-acceptance.md)) |
| `cash.variance_alert_fils` / `cash.variance_alert_days` | `2000` / `30` | [0058](decisions/0058-shift-variance-acceptance.md) (migration 0022) |
| `cash.drop_alert_fils` | `300000` | A drawer above AED 3,000 raises the cash-drop alert ([0057](decisions/0057-cash-drop-alert.md)) |
| `sales.quotation_validity_days` | `30` | |
| `einvoice.mandatory_from` | `null` | **Pending accountant** ([0019](decisions/0019-einvoicing-via-accredited-provider.md)) |
| `backup.max_age_minutes.local` / `backup.max_age_hours.offsite` | `90` / `30` | Ranges 30–1440 / 24–168 (0036) |
| `backup.restore_test_interval_days` | `30` | Range 7–90 |
| `backup.offline_copy_interval_days` | `7` | External-drive reminder, range 1–60 (0036) |
| `backup.age_recipient` | `null` | The age public key of the off-site copies; only `age1…` accepted (0036). The private key is never stored |

---

## 16. Migration order (Phase 1)

Migrations are written **in build order** (milestones in [`phase-1-plan.md`](phase-1-plan.md)), so every milestone ships a working, tested database.

- **One transaction each:** every migration runs in a single transaction.
- **Self-contained:** a migration creates its tables and their CHECKs, triggers and views. It also adds the audit triggers (`audit.enable_for(table, ignored, redacted)`), the **grants** for the roles in §2, and its own **seed data** from §15.
- **Forward references:** a foreign key to a table that a later milestone creates is added by that later migration (`ALTER TABLE … ADD CONSTRAINT`). These are listed in the "Adds deferred FKs" column.
- **Cluster roles** are created by the installer, not by migrations.

| # | Migration | Milestone | Creates | Adds deferred FKs |
|---|---|---|---|---|
| 0001 | `extensions_schemas_helpers` | M0 | `pg_trgm`, `btree_gist`; the 9 schemas; `normalize_search`, `business_date`, `round_div`, `set_context`, `touch_row`, guard functions | — |
| 0002 | `audit` | M0 | `audit.log`, `chain_head`, `anchors`, `verifications`; capture / seal / verify / event / anchor functions | — |
| 0003 | `auth_core` | M0 | `users` (+ SYSTEM), `roles` (5 defaults), `permissions` (seeded), `role_permissions`, `user_roles` | — |
| 0004 | `sys_core` | M0 | `company_profile`, `settings` (defaults), `branches` (HQ), `document_series` (all 13 series) + `next_number`, `alerts`, `import_batches` | — |
| 0005 | `auth_devices` | M1 | `devices`, `device_activity`, `enrollment_codes`, `sessions`, `approvals`, `recovery_codes`, `sys.idempotency_keys`; sign-in method and deactivation columns on `users`; `owner_only` permissions; owner and 2-step rules; security settings | — |
| 0006 | `device_trust` | M1 | `auth.device_trust` ("trust this PC", decision 0027), `trusted_device` sign-in method, `security.trusted_device_days` | — |
| 0007 | `company_edit_owner_only` | M1 | — (data: `system.company.edit` becomes owner-only and leaves every other role, decision 0030) | — |
| 0008 | `gl_core` | M2 | `accounts` (provisional chart), `account_mappings`, `periods` (monthly, seeded) + period guard | — |
| 0009 | `master_data` | M2 | All 15 `md.*` tables (with seeds) and `sys.reason_codes` (with seeds); permission `customers.credit`; deactivation needs a reason; company TRN starts with 100 and the logo is PNG/JPEG; series prefix changeable until first use (decisions 0031–0037) | `auth.devices.default_warehouse_id`, `auth.approvals.reason_code_id` |
| 0010 | `item_purchase_cost` | M2b | — (data/rules: purchase price may be set on services too, kits never; permission `items.cost`, owner-only; trigger requires it; decision 0038) | — |
| 0011 | `inventory` | M3 | All `inv.*` tables + `apply_movement`; `md.label_sizes`; `gl.assert_period_open`; stock reason codes; permission `stock.opening` (owner-only); decisions 0003, 0015, 0040–0044 | — |
| 0012 | `gl_journals` | M3 | `journal_entries`, `journal_lines` + balance check at commit, no double posting, open month only; `gl.account_in_use` returns `posted` | — |
| 0013 | `inventory_hardening` | M3 | — (rules: a movement only for an open document and its own line; the approval threshold uses the movements' value; opening stock once per item; `inv.lock_balances` for counts; found in the M3 code review) | — |
| 0014 | `cash_core` | M4 | `registers`, `shifts`, `counts`, `count_lines` + shift-owner function | — |
| 0015 | `sales` | M4 | All `sales.*` tables + allocation, advance-deduction, note and payment-allocation triggers + sales views | `inv.movements.sales_document_line_id`, `inv.adjustments.sales_document_id`, `gl.journal_entries` (sales document, payment, opening balance, shift) |
| 0016 | `outbox_print` | M4 | `ops.outbox`, `sys.print_templates`, `sys.print_template_versions` (default A4 designs, decision 0050) | `print_template_version_id` on documents, quotations and payments |
| 0017 | `sales_fixes` | M4 | — (a converted line keeps the quotation price; prices and discounts checked when a quotation is sent; advance lines on a credit note of a payment invoice; `sales.credit_over_limit` bypasses the credit check) | `sales.document_lines.quotation_line_id` |
| 0018 | `sales_review_fixes` | M4 | — (a price approval never waives the discount limit; note lines follow their original line; an issued document with nothing to pay is settled) | `sales.quotations.price_approval_id` |
| 0019 | `new_item_quantity` | M4 | — (permission `stock.new_item_quantity` for owner, accountant, storekeeper; opening stock allowed for an item created in the same transaction, decision 0053) | — |
| 0020 | `storekeeper_items` | M4 | — (`items.manage` for the storekeeper role, decision 0053) | — |
| 0021 | `no_adjustment_approval` | M4 | — (the adjustment approval limit setting is emptied, decision 0054) | — |
| 0022 | `cash_events` | M5 | `cash.movements`, `cash.drawer_events`, `cash.variance_acceptances`, `cash.expected_cash()`, count other amount, 0.10/0.05 coins, cash alert settings, cashier 5% discount | `gl.journal_entries.cash_movement_id`, `shift_id` |
| 0023 | `print_designer` | M4b | `sys.company_bank_accounts`, `sys.valid_uae_iban()`, `customer_po` on documents and quotations, the full-invoice address rule, the current-template rule, receipts stamped with the invoice template, the receipt language into its template | — |
| 0024 | `stuck_shifts` | M5 fix | `shifts.force_close`, closing a stuck shift from another PC, moving a drawer to a re-enrolled PC, no revoking a PC with an open shift (0069) | — |
| 0025 | `a4_full_invoices` | M4 fix | A4 invoices always full tax invoices; the cash customer's typed name required (0071) | — |
| 0026 | `invoice_cancel` | M4 fix | `invoices.cancel` (owner only), credit-note reasons for cancelled and edited invoices (0072) | — |
| 0027 | `a4_format_from_customer` | M4 fix | A4 invoice format from the customer only: full when registered or named with an address, else simplified (0071) | — |
| 0028 | `approval_codes` | M5 fix | Approval-code failure count and block on users (0074) | — |
| 0029 | `receipt_logo` | M4b fix | `sys.receipt_logo`: the thermal receipt's own logo, owner only (0075) | — |
| 0030 | `trust_until_password_change` | M1 fix | `security.trusted_device_days` 3650 (until the password changes), range 0–3650; trust expiry check up to 3650 days (0077) | — |
| 0031 | `owner_trust_on_pos` | M1 fix | `auth.is_owner()`; the owner may trust a POS PC; a PC turned POS keeps only the owner's trust (0078) | — |
| 0032 | `screen_lock_optional` | M1 fix | `security.idle_lock_minutes.office/pos` may be 0 (never lock) and are set to 0 (0079) | — |
| 0033 | `owner_dashboard` | Reports | `reports.owner_dashboard` (owner only), index on issued documents by day (0081) | — |
| 0034 | `kiosk_lock` | M5c | `auth.kiosk_lock_changes`, `auth.kiosk_code_failures`, `auth.kiosk_state()`, four kiosk alert types (0082, 0083, 0089) | — |
| 0035 | `kiosk_owner_session` | M5c | `auth.owner_signed_in_on()`, `auth.kiosk_state()` with `owner_signed_in`; owner code at most 15 minutes (0091) | — |
| 0036 | `ops_backup` | M6.1 | `ops.backup_runs`, `ops.integrity_runs`, `ops.backup_requests`; backup settings; `offline_copy_due` alert; `system.backup.manage` and owner-only health/restore/integrity permissions; backup role grants | — |
| 0040 | `label_design` | Labels | `md.items.pack_ar` / `pack_en` (sale pack for labels, ≤ 40 characters); the default label design as a version of the `barcode_label` print template (read by `GET /api/v1/label-design`, saved by the owner via `POST /api/v1/label-design/versions`); decision 0097 | — |
| 0039 | `label_printer_quality` | Labels | `auth.valid_label_printer` also takes optional `darkness` (0–15), `speed` (1–6) and `mode` (`driver` / `tspl`); decision 0097 | — |
| 0038 | `device_label_printer` | Labels | Check on `auth.devices.printer_config -> 'label'` (`auth.valid_label_printer`); decision 0096 | — |
| 0037 | `label_sizes_two_inch` | Labels | Setting `labels.max_width_mm` (50); label sizes for the 2-inch roll (50×30 first; 25×15, 30×20, 58×40, 100×50 deactivated); trigger: no active size wider than the roll; decision 0096 | — |

After 0036, a final check asserts that every business table has the audit trigger, the no-delete guard and the expected grants. The same check runs as an automated test.

---

## 17. Not in Phase 1 (added later by migration)

| Phase | Tables / changes |
|---|---|
| P2 | `purchasing.*` (orders, receipts, supplier invoices, supplier payments), `expenses.*` + attachments, `ops.export_runs` (quarterly VAT package / annual archive register, [0017](decisions/0017-quarterly-vat-export-and-annual-archive.md)), `gl.bank_reconciliations`, manual journal approval, movement types `purchase_receipt` / `purchase_return` |
| P3 | `service.pool_sites`, `service.contracts` / `visit_schedules` / `visits` / `visit_readings`, `service.job_cards`, `projects.projects` / `budgets` / `cost_entries` (projects link to quotations and to the P1 advance/progress payment invoices); van warehouses + `transfer_*` / `consumption` movements; `inv.item_warehouse_settings` |
| P4 (or earlier) | E-invoice sender on `ops.outbox`; `promo.*`, `loyalty.*`; standby replication |
