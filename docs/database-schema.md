# ARTÉPOOL ERP — Phase 1 Database Schema

| | |
|---|---|
| **Status** | Approved with the Phase 1 plan (2026-10-07). This is a design document; the SQL migrations implement it milestone by milestone. |
| **Date** | 2026-10-06 |
| **Database** | PostgreSQL 18 (≥ 16 compatible, except `uuidv7()`, which the API can generate on 16/17) |
| **Related** | [`architecture.md`](architecture.md) · [`phase-1-plan.md`](phase-1-plan.md) · [`decisions/`](decisions/README.md) · [`accounting/`](accounting/chart-of-accounts.md) |

Phase 1 has **65 tables in 9 schemas**, plus reporting views and the functions and triggers that enforce the rules. Tables for later phases are listed in §17.

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

**Notation:** `→ x.y` means a foreign key. A type followed by `?` is nullable; every other column is `NOT NULL`.

---

## 2. Database roles and privileges

| Role | Login? | Used by | Privileges |
|---|---|---|---|
| `postgres` | yes | Nobody in daily work | Password held offline by the owner |
| `artepool_owner` | no | Owns every object | — |
| `artepool_migrator` | yes (server only) | Migration runner | Member of `artepool_owner` |
| `artepool_api` | yes (server only) | API service | See below |
| `artepool_backup` | yes (server only) | Backup agent | `pg_read_all_data`, `REPLICATION`; write `ops.backup_runs`, `ops.integrity_runs`; `audit.add_anchor()` |
| `artepool_maint` | yes (server only) | Nightly maintenance | `DELETE` only on `sys.idempotency_keys` older than 30 days and ended `auth.sessions` older than 1 year (technical rows, never business records) |

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
- **Functions it may call:** `sys.set_context`, `sys.next_number`, `audit.record_event`, `audit.verify_chain`.
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
     ▲     auth.devices · auth.sessions · auth.approvals (single-use supervisor approvals)
     │
 sys.company_profile · sys.settings · sys.branches · sys.document_series (POS-, INV-, CN-, …)

 md.business_lines (supplies / construction / maintenance / cleaning) ─► gl.accounts (revenue, cost of sales)
 md.items ◄─ md.item_barcodes · md.bundle_components · md.item_prices ─► md.price_lists
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

 audit.log (hash-chained) ◄─ every table + explicit events         ops.outbox · ops.backup_runs · ops.integrity_runs
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
| gl_account_id | bigint? → gl.accounts | Account for paid-in/paid-out reasons |
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

Written in the same transaction as the operation.

### 4.8 `sys.alerts`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| alert_type | text | `CHECK IN ('low_stock','oversell_review','cash_drop_due','cash_variance','repeated_variance','drawer_left_open','backup_failed','backup_stale','restore_test_due','integrity_issue','audit_chain_broken','clock_skew','clock_backwards','period_missing')` |
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

---

## 5. Schema `auth`

### 5.1 `auth.users`

The audit trigger **redacts** `password_hash`, `pin_hash` and `totp_secret_enc`; it records only that they changed. It ignores `last_login_at`.

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | 1 = SYSTEM |
| username | text | Unique `lower(username)`; `CHECK (username ~ '^[a-z0-9._-]{3,32}$')` |
| display_name_ar, display_name_en | text | |
| phone, email | text? | |
| password_hash | text? | Argon2id. `CHECK (id = 1 OR password_hash IS NOT NULL)` |
| password_changed_at | timestamptz? | |
| must_change_password | boolean | `DEFAULT true` |
| pin_hash | text? | Argon2id of a 4–6 digit PIN (user switch + supervisor approvals) |
| pin_failed_count | smallint | `DEFAULT 0` |
| totp_secret_enc | bytea? | AES-256-GCM; key outside the DB (DPAPI) |
| totp_enabled | boolean | `CHECK (NOT totp_enabled OR totp_secret_enc IS NOT NULL)` |
| totp_last_step | bigint? | Blocks replay |
| failed_login_count | smallint | `DEFAULT 0` |
| locked_until | timestamptz? | |
| last_login_at | timestamptz? | |
| language | text | `DEFAULT 'ar'`, `CHECK IN ('ar','en')` |
| max_discount_bp | integer? | Overrides the role limit, `0..10000` |
| max_discount_fils | bigint? | `>= 0` |
| [active], [std] | | |

### 5.2 `auth.roles`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique |
| name_ar, name_en | text | |
| is_system | boolean | The 5 default roles: code fixed, cannot be deactivated |
| requires_2fa | boolean | `true` for Owner |
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

The audit trigger ignores `last_seen_at`, `last_ip` and `app_version`.

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique (`POS-01`) |
| name | text | |
| device_kind | text | `CHECK IN ('pos','office','warehouse','server')` |
| branch_id | bigint → sys.branches | |
| default_warehouse_id | bigint? → md.warehouses | |
| status | text | `CHECK IN ('pending','active','revoked')` |
| enrollment_code_hash | bytea? | One-time code |
| enrollment_expires_at | timestamptz? | 15 minutes |
| secret_hash | bytea? | Unique; SHA-256 of the device secret. `CHECK (status <> 'active' OR secret_hash IS NOT NULL)` |
| enrolled_at | timestamptz? | |
| enrolled_by | bigint? → auth.users | |
| last_seen_at | timestamptz? | |
| last_ip | inet? | |
| app_version | text? | |
| printer_config | jsonb | `DEFAULT '{}'`: thermal / label / A4 printer names, receipt width and language |
| revoked_at | timestamptz? | |
| revoked_by | bigint? → auth.users | |
| revoke_reason | text? | |
| [std] | | |

### 5.7 `auth.sessions`

Not row-audited. Login, logout, lock and switch are explicit audit events.

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| token_hash | bytea | unique; SHA-256 of the opaque token |
| user_id | bigint → auth.users | |
| device_id | bigint → auth.devices | |
| auth_method | text | `CHECK IN ('password','password_totp','pin_switch')` |
| created_at, last_activity_at | timestamptz | |
| idle_timeout_sec | integer | `> 0` |
| expires_at | timestamptz | `CHECK (expires_at > created_at)` |
| ended_at | timestamptz? | |
| end_reason | text? | `CHECK IN ('logout','idle_lock','expired','revoked','user_switch','password_changed','device_revoked')` |
| client_ip | inet? | |

### 5.8 `auth.approvals` (single-use)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| permission_code | text → auth.permissions | The action approved (must be `approvable`) |
| requested_by | bigint → auth.users | |
| approved_by | bigint → auth.users | `CHECK (approved_by <> requested_by)` |
| device_id | bigint → auth.devices | |
| reason_code_id | bigint? → sys.reason_codes | |
| reason_text | text | `CHECK (length(btrim(reason_text)) >= 3)` |
| context | jsonb | e.g. `{"item_id":42,"qty_short":"2.000"}`, `{"discount_bp":1500,"limit_bp":1000}` |
| approved_at | timestamptz | |
| expires_at | timestamptz | Default `approved_at + 5 min` |
| consumed_at | timestamptz? | Set exactly once |
| consumed_entity | text? | e.g. `sales.documents:123` |

The guard allows only `consumed_*` to change, only from NULL, and only before `expires_at`.

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
| code | text | unique: `SR` (5%), `ZR`, `EX`, `OS` |
| name_ar, name_en | text | |
| rate_bp | integer | `CHECK 0..10000`. Configurable ([0009](decisions/0009-vat-per-line.md)). |
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
| code | text | unique |
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
| fallback_unit_cost_4dp | bigint? | `>= 0`; values an approved oversell when no average cost is known |
| is_sellable | boolean | `DEFAULT true` |
| [active], [std] | | |

The average cost is not stored on the item. It lives in `inv.balances.avg_unit_cost_4dp`.

### 7.6 `md.item_barcodes`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| item_id | bigint → md.items | |
| barcode | text | `CHECK (barcode ~ '^[0-9A-Za-z.\-]{3,64}$')`; unique `WHERE is_active` |
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

### 7.8 `md.price_lists`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique (`RETAIL`, `CONTRACTOR`) |
| name_ar, name_en | text | |
| prices_include_vat | boolean | Retail = `true` |
| is_default | boolean | One default |
| [active], [std] | | |

### 7.9 `md.item_prices`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| price_list_id | bigint → md.price_lists | `UNIQUE (price_list_id, item_id)` |
| item_id | bigint → md.items | |
| price_4dp | bigint | `>= 0`; 4-decimal unit price, inclusive or exclusive per the list |
| [std] | | History is in the audit log |

### 7.10 `md.customers`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique |
| customer_type | text | `CHECK IN ('individual','business')` |
| name | text | |
| name_alt | text? | |
| search_key | text | Generated (code, names, phone) |
| is_vat_registered | boolean | `DEFAULT false`. Decides the invoice format ([0010](decisions/0010-invoice-format-by-vat-registration.md)). |
| trn | char(15)? | `CHECK (trn ~ '^[0-9]{15}$')`; `CHECK (NOT is_vat_registered OR trn IS NOT NULL)` |
| phone, phone_alt | text? | E.164 |
| email | text? | |
| address_line, area, city, po_box | text? | |
| emirate | text? | |
| country_code | char(2) | `'AE'` |
| price_list_id | bigint? → md.price_lists | |
| payment_terms_days | smallint | `DEFAULT 0`, `0..365` |
| credit_limit_fils | bigint | `DEFAULT 0` (cash only), `>= 0` |
| is_walk_in | boolean | Exactly one "Cash customer" |
| preferred_language | text? | |
| notes | text? | |
| [active], [std] | | |

### 7.11 `md.suppliers`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| code | text | unique |
| name | text | |
| name_alt | text? | |
| search_key | text | Generated |
| is_vat_registered | boolean | |
| trn | char(15)? | As customers |
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
| is_default | boolean | |
| [active], [std] | | |

### 7.15 `md.cash_denominations`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| value_fils | bigint | unique, `> 0` |
| kind | text | `CHECK IN ('note','coin')` |
| sort_order | integer | |
| [active], [std] | | |

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
| quotation_date | date | |
| valid_until | date | `>= quotation_date` |
| price_list_id | bigint → md.price_lists | |
| prices_include_vat | boolean | |
| salesperson_id | bigint? → auth.users | |
| subject | text? | |
| terms_ar, terms_en, notes | text? | |
| discount_total_fils, net_fils, vat_fils, total_fils | bigint | `>= 0`; `total = net + vat`; non-optional lines only |
| approval_id | bigint? → auth.approvals | |
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
| bill_to_name_alt, bill_to_trn, bill_to_address, bill_to_phone | text? | Snapshot; the TRN is copied only if the customer is VAT-registered |
| seller_snapshot | jsonb? | |
| issue_date | date? | |
| supply_date | date? | |
| issued_at | timestamptz? | |
| due_date | date? | `>= issue_date` |
| currency | char(3) | `'AED'` |
| price_list_id | bigint? → md.price_lists | NULL for `advance_invoice` |
| prices_include_vat | boolean | `CHECK (doc_type <> 'advance_invoice' OR prices_include_vat)` (amount received includes VAT) |
| salesperson_id | bigint? → auth.users | |
| quotation_id | bigint? → sales.quotations | Agreement that invoices and payment invoices belong to |
| original_document_id | bigint? → sales.documents | `CHECK ((doc_type IN ('credit_note','debit_note')) = (original_document_id IS NOT NULL))`; the original must be an issued `invoice` or `advance_invoice` of the same customer |
| reason_code_id | bigint? → sys.reason_codes | |
| reason_text | text? | Required for notes |
| approval_id | bigint? → auth.approvals | |
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
| list_price_4dp | bigint | Price-list price (item lines) |
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

### 10.5 `cash.movements` (append-only)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| uuid | uuid | |
| series_id | bigint → sys.document_series | `CV-`; `UNIQUE (series_id, seq_no)` |
| seq_no | bigint | |
| voucher_number | text | |
| shift_id | bigint → cash.shifts | Open; the user must be its cashier |
| movement_type | text | `CHECK IN ('paid_in','paid_out','cash_drop','float_top_up')` |
| amount_fils | bigint | `> 0` |
| reason_code_id | bigint → sys.reason_codes | Mandatory |
| note | text? | |
| counterparty | text? | |
| approval_id | bigint? → auth.approvals | |
| drop_count_id | bigint? → cash.counts | |
| [ins] | | |

### 10.6 `cash.drawer_events` (append-only)

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| register_id | bigint → cash.registers | |
| shift_id | bigint? → cash.shifts | |
| event_type | text | `CHECK IN ('open_sale','open_payment','open_cash_movement','open_count','open_no_sale','reported_open','reported_closed','left_open_alert')` |
| sales_document_id | bigint? → sales.documents | |
| payment_id | bigint? → sales.payments | |
| cash_movement_id | bigint? → cash.movements | |
| reason_code_id | bigint? → sys.reason_codes | Required for `open_no_sale` |
| approval_id | bigint? → auth.approvals | |
| user_id | bigint → auth.users | |
| device_id | bigint → auth.devices | |
| occurred_at | timestamptz | |

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

### 12.2 `ops.backup_runs`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| kind | text | `CHECK IN ('wal_archive','base_backup','logical_dump','offsite_upload','offline_copy','restore_test')` |
| status | text | `CHECK IN ('running','success','failed')` |
| started_at | timestamptz | |
| finished_at | timestamptz? | |
| target, file_name | text? | Never credentials |
| size_bytes | bigint? | |
| sha256 | bytea? | |
| encrypted | boolean | |
| audit_chain_seq | bigint? | |
| audit_chain_hash | bytea? | |
| details | jsonb? | |
| error_message | text? | |

### 12.3 `ops.integrity_runs`

| Column | Type | Rules |
|---|---|---|
| id | bigint PK | |
| database_name | text | |
| triggered_by | bigint → auth.users | |
| started_at | timestamptz | |
| finished_at | timestamptz? | |
| status | text | `CHECK IN ('ok','issues','error')` |
| results | jsonb | `audit_chain`, `stock_vs_ledger`, `journals_balanced`, `documents_vs_journals`, `numbering_gaps`, `document_totals`, `settlement_totals`, `advance_balances`, `payments_fully_allocated`, `shift_cash`, `period_integrity` |

---

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
| `sys.clock_guard()` | function | Detects the server clock going backwards |

---

## 15. Reference and seed data

### 15.1 Permissions

| Module | Codes |
|---|---|
| system | `system.company.edit`, `system.settings.edit`, `system.series.manage`, `system.devices.manage`, `system.health.view`, `system.backup.restore_test`, `system.integrity.run` |
| users | `users.view`, `users.manage`, `users.reset_credentials`, `roles.manage` |
| audit | `audit.view`, `audit.verify`, `audit.export` |
| master data | `items.view`, `items.manage`, `prices.manage`, `customers.view`, `customers.manage`, `suppliers.manage`, `technicians.manage`, `payment_methods.manage`, `warehouses.manage`, `data.import` |
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
| **Accountant** | All except users, roles, devices and system settings |
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
- **Units:** `PCS`, `BOX`, `SET`, `KG`, `L`, `M`, `M2`, `HR`, `VISIT`, `JOB`.
- **Lines of business:** supplies (4100/5100), construction (4200/5200), maintenance (4300/5300), cleaning (4400/5400).
- **Chart of accounts and mappings:** the provisional chart from [`accounting/chart-of-accounts.md`](accounting/chart-of-accounts.md).
- **Payment methods:** Cash (1110), Card (1150), Bank transfer (1140), Cheque (1160).
- **AED denominations:** notes 1000–5; coins 1 AED, 50 fils, 25 fils.
- **Branch and warehouse:** branch `HQ` (Al Ain); warehouse `MAIN`.
- **Price lists:** `RETAIL` (VAT-inclusive, default) and `CONTRACTOR` (VAT-exclusive).
- **Walk-in customer:** "عميل نقدي / Cash customer" (not VAT-registered).
- **Periods:** monthly periods for the current fiscal year plus 3 months ahead.
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
| `clock.max_client_skew_seconds` | `120` | |
| `pos.out_of_stock_mode` | `"allow_with_approval"` | [0003](decisions/0003-pos-oversell-with-approval.md) |
| `pos.default_business_line` | `"supplies"` | |
| `print.pos_receipt_auto` | `true` | Silent thermal printing ([0008](decisions/0008-printing-pos-silent-a4-section.md)) |
| `print.receipt_language` | `"both"` | |
| `print.mark_reprints_as_copy` | `true` | |
| `inventory.adjustment_approval_threshold_fils` | `50000` | 500 AED; adjustable |
| `cash.variance_alert_repeat_count` | `3` | Within 30 days |
| `sales.quotation_validity_days` | `30` | |
| `einvoice.mandatory_from` | `null` | **Pending accountant** ([0019](decisions/0019-einvoicing-via-accredited-provider.md)) |
| `backup.max_age_minutes.local` / `backup.max_age_hours.offsite` | `90` / `30` | |
| `backup.restore_test_interval_days` | `30` | |

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
| 0005 | `auth_devices` | M1 | `devices`, `sessions`, `approvals`, `sys.idempotency_keys` | — |
| 0006 | `gl_core` | M2 | `accounts` (provisional chart), `account_mappings`, `periods` (monthly, seeded) + period guard | — |
| 0007 | `master_data` | M2 | All 15 `md.*` tables (with seeds) and `sys.reason_codes` (with seeds) | `auth.devices.default_warehouse_id`, `auth.approvals.reason_code_id` |
| 0008 | `inventory` | M3 | All `inv.*` tables + `apply_movement` + stock views | — |
| 0009 | `gl_journals` | M3 | `journal_entries`, `journal_lines` + balance trigger | — |
| 0010 | `cash_core` | M4 | `registers`, `shifts`, `counts`, `count_lines` + shift-owner function | — |
| 0011 | `sales` | M4 | All `sales.*` tables + allocation, advance-deduction, note and payment-allocation triggers + sales views | `inv.movements.sales_document_line_id`, `inv.adjustments.sales_document_id`, `gl.journal_entries` (sales document, payment, opening balance, shift) |
| 0012 | `ops_outbox` | M4 | `ops.outbox` | — |
| 0013 | `cash_events` | M5 | `cash.movements`, `cash.drawer_events` + shift summary view | `gl.journal_entries.cash_movement_id` |
| 0014 | `ops_backup` | M6 | `ops.backup_runs`, `ops.integrity_runs` + backup role grants | — |

After 0014, a final check asserts that every business table has the audit trigger, the no-delete guard and the expected grants. The same check runs as an automated test.

---

## 17. Not in Phase 1 (added later by migration)

| Phase | Tables / changes |
|---|---|
| P2 | `purchasing.*` (orders, receipts, supplier invoices, supplier payments), `expenses.*` + attachments, `ops.export_runs` (quarterly VAT package / annual archive register, [0017](decisions/0017-quarterly-vat-export-and-annual-archive.md)), `gl.bank_reconciliations`, manual journal approval, movement types `purchase_receipt` / `purchase_return` |
| P3 | `service.pool_sites`, `service.contracts` / `visit_schedules` / `visits` / `visit_readings`, `service.job_cards`, `projects.projects` / `budgets` / `cost_entries` (projects link to quotations and to the P1 advance/progress payment invoices); van warehouses + `transfer_*` / `consumption` movements; `inv.item_warehouse_settings` |
| P4 (or earlier) | E-invoice sender on `ops.outbox`; `promo.*`, `loyalty.*`; standby replication |
