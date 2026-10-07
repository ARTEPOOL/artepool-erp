-- 0004_sys_core.sql
-- Purpose: company profile, settings, branches, gapless numbering series, alerts and import
-- batches (docs/database-schema.md §4.2–4.5, §4.8–4.9, §15.2, §15.4; decision 0011).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0004: company, settings, numbering');

-- ---------------------------------------------------------------------------------------------
-- Company profile (exactly one row; filled through the setup screen in M2)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sys.company_profile (
  id               smallint PRIMARY KEY CHECK (id = 1),
  legal_name_ar    text NOT NULL CHECK (btrim(legal_name_ar) <> ''),
  legal_name_en    text NOT NULL CHECK (btrim(legal_name_en) <> ''),
  trade_name_ar    text,
  trade_name_en    text,
  vat_registered   boolean NOT NULL,
  trn              char(15) CHECK (trn ~ '^[0-9]{15}$'),
  address_ar       text NOT NULL,
  address_en       text NOT NULL,
  city             text,
  po_box           text,
  phone            text,
  email            text,
  website          text,
  emirate          text CHECK (emirate IN ('abu_dhabi', 'dubai', 'sharjah', 'ajman', 'umm_al_quwain',
                                           'ras_al_khaimah', 'fujairah')),
  logo             bytea CHECK (octet_length(logo) <= 524288),
  logo_mime        text CHECK (logo_mime IN ('image/png', 'image/jpeg', 'image/svg+xml')),
  currency         char(3) NOT NULL DEFAULT 'AED' CHECK (currency = 'AED'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       bigint NOT NULL REFERENCES auth.users (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       bigint NOT NULL REFERENCES auth.users (id),
  row_version      integer NOT NULL DEFAULT 1,
  CONSTRAINT company_trn_ck CHECK (NOT vat_registered OR trn IS NOT NULL),
  CONSTRAINT company_logo_ck CHECK ((logo IS NULL) = (logo_mime IS NULL))
);
SELECT sys.add_touch('sys.company_profile');
SELECT audit.enable_for('sys.company_profile', p_redacted => ARRAY['logo']);
SELECT sys.forbid_delete('sys.company_profile');

-- ---------------------------------------------------------------------------------------------
-- Settings (keys are defined by migrations; values are edited in the app)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sys.settings (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  value        jsonb NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint NOT NULL REFERENCES auth.users (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint NOT NULL REFERENCES auth.users (id),
  row_version  integer NOT NULL DEFAULT 1
);
SELECT sys.add_touch('sys.settings');
SELECT audit.enable_for('sys.settings', p_keys => ARRAY['key']);
SELECT sys.forbid_delete('sys.settings');

INSERT INTO sys.settings (key, value, description) VALUES
  ('locale.default_language', '"ar"', 'Language for new users and printed documents'),
  ('locale.digits', '"latn"', 'Digits shown in the app: latn (0-9) or arab'),
  ('locale.date_format', '"dd/MM/yyyy"', 'Date format'),
  ('security.max_failed_logins', '5', 'Failed logins before the account locks'),
  ('security.lockout_minutes', '15', 'How long a locked account stays locked'),
  ('security.idle_lock_minutes.office', '15', 'Office PCs lock after this many idle minutes'),
  ('security.idle_lock_minutes.pos', '5', 'POS PCs lock after this many idle minutes'),
  ('security.session_max_hours', '12', 'A session ends after this many hours'),
  ('security.approval_validity_seconds', '300', 'A supervisor approval expires after this many seconds'),
  ('clock.max_client_skew_seconds', '120', 'PC clock difference that raises an alert'),
  ('pos.out_of_stock_mode', '"allow_with_approval"', 'Out-of-stock at the POS (decision 0003)'),
  ('pos.default_business_line', '"supplies"', 'Line of business for POS sales'),
  ('print.pos_receipt_auto', 'true', 'POS receipts print silently (decision 0008)'),
  ('print.receipt_language', '"both"', 'Receipt language: ar, en or both'),
  ('print.mark_reprints_as_copy', 'true', 'Prints after the first are marked Copy (decision 0008)'),
  ('inventory.adjustment_approval_threshold_fils', '50000', 'Adjustments above this value need approval'),
  ('cash.variance_alert_repeat_count', '3', 'Variances within 30 days that raise an alert'),
  ('sales.quotation_validity_days', '30', 'Default quotation validity'),
  ('einvoice.mandatory_from', 'null', 'E-invoicing go-live date (pending accountant, decision 0019)'),
  ('backup.max_age_minutes.local', '90', 'Alert when the last local backup is older than this'),
  ('backup.max_age_hours.offsite', '30', 'Alert when the last off-site backup is older than this'),
  ('backup.restore_test_interval_days', '30', 'Restore test reminder interval');

-- ---------------------------------------------------------------------------------------------
-- Branches
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sys.branches (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name_ar      text NOT NULL CHECK (btrim(name_ar) <> ''),
  name_en      text NOT NULL CHECK (btrim(name_en) <> ''),
  address_ar   text,
  address_en   text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint NOT NULL REFERENCES auth.users (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint NOT NULL REFERENCES auth.users (id),
  row_version  integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX branches_code_uq ON sys.branches (lower(code));
SELECT sys.add_touch('sys.branches');
SELECT audit.enable_for('sys.branches');
SELECT sys.forbid_delete('sys.branches');

INSERT INTO sys.branches (code, name_ar, name_en)
VALUES ('HQ', 'المقر الرئيسي – العين', 'Head office – Al Ain');

-- ---------------------------------------------------------------------------------------------
-- Gapless numbering series (golden rule 5, decision 0011)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sys.document_series (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_type      text NOT NULL CHECK (doc_type IN (
                  'quotation', 'invoice', 'credit_note', 'debit_note', 'receipt', 'refund',
                  'payment_reversal', 'cash_voucher', 'shift', 'stock_adjustment', 'stock_count',
                  'journal')),
  channel       text CHECK (channel IN ('pos', 'office')),
  branch_id     bigint NOT NULL REFERENCES sys.branches (id),
  code          text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  prefix        text NOT NULL CHECK (prefix ~ '^[A-Z0-9-]{1,16}$'),
  number_width  smallint NOT NULL DEFAULT 6 CHECK (number_width BETWEEN 1 AND 12),
  start_number  bigint NOT NULL DEFAULT 1 CHECK (start_number > 0),
  next_number   bigint NOT NULL,
  is_default    boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint NOT NULL REFERENCES auth.users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint NOT NULL REFERENCES auth.users (id),
  row_version   integer NOT NULL DEFAULT 1,
  CONSTRAINT series_channel_ck CHECK (doc_type <> 'invoice' OR channel IS NOT NULL),
  CONSTRAINT series_next_ck CHECK (next_number >= start_number),
  CONSTRAINT series_prefix_uq UNIQUE (doc_type, prefix)
);
CREATE UNIQUE INDEX series_code_uq ON sys.document_series (lower(code));
CREATE UNIQUE INDEX series_default_uq ON sys.document_series (doc_type, coalesce(channel, ''), branch_id)
  WHERE is_default AND is_active;

CREATE FUNCTION sys.series_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.next_number := NEW.start_number;
  RETURN NEW;
END $$;
CREATE TRIGGER b_series_start BEFORE INSERT ON sys.document_series
  FOR EACH ROW EXECUTE FUNCTION sys.series_before_insert();

CREATE FUNCTION sys.guard_series() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.doc_type, NEW.channel, NEW.branch_id, NEW.code, NEW.prefix, NEW.number_width, NEW.start_number)
     IS DISTINCT FROM
     (OLD.doc_type, OLD.channel, OLD.branch_id, OLD.code, OLD.prefix, OLD.number_width, OLD.start_number) THEN
    RAISE EXCEPTION 'A numbering series cannot be changed once created; create a new series instead'
      USING ERRCODE = 'AP003';
  END IF;
  IF NEW.next_number <> OLD.next_number AND NEW.next_number <> OLD.next_number + 1 THEN
    RAISE EXCEPTION 'Document numbers can only advance one at a time (% → %)', OLD.next_number, NEW.next_number
      USING ERRCODE = 'AP005';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_series BEFORE UPDATE ON sys.document_series
  FOR EACH ROW EXECUTE FUNCTION sys.guard_series();

SELECT sys.add_touch('sys.document_series');
-- The counter itself is not audited: every document carries its own number and is audited.
SELECT audit.enable_for('sys.document_series', p_ignored => ARRAY['next_number']);
SELECT sys.forbid_delete('sys.document_series');

-- Takes the next number inside the caller's transaction. The row stays locked until commit, and a
-- rollback gives the number back, so numbers are gapless and never repeat.
CREATE FUNCTION sys.next_number(p_series_id bigint, OUT seq_no bigint, OUT formatted text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_prefix text;
  v_width smallint;
  v_digits text;
BEGIN
  UPDATE sys.document_series
     SET next_number = next_number + 1
   WHERE id = p_series_id AND is_active
  RETURNING next_number - 1, prefix, number_width INTO seq_no, v_prefix, v_width;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Numbering series % was not found or is not active', p_series_id USING ERRCODE = 'AP007';
  END IF;
  v_digits := seq_no::text;
  formatted := v_prefix || CASE WHEN length(v_digits) >= v_width THEN v_digits
                                ELSE lpad(v_digits, v_width, '0') END;
END $$;

INSERT INTO sys.document_series (doc_type, channel, branch_id, code, prefix, is_default)
SELECT s.doc_type, s.channel, b.id, s.code, s.prefix, true
  FROM sys.branches AS b,
       (VALUES ('invoice', 'pos', 'POS', 'POS-'),
               ('invoice', 'office', 'INV', 'INV-'),
               ('credit_note', NULL, 'CN', 'CN-'),
               ('debit_note', NULL, 'DN', 'DN-'),
               ('quotation', NULL, 'Q', 'Q-'),
               ('receipt', NULL, 'RCT', 'RCT-'),
               ('refund', NULL, 'RFD', 'RFD-'),
               ('payment_reversal', NULL, 'RVS', 'RVS-'),
               ('cash_voucher', NULL, 'CV', 'CV-'),
               ('shift', NULL, 'Z', 'Z-'),
               ('stock_adjustment', NULL, 'ADJ', 'ADJ-'),
               ('stock_count', NULL, 'CNT', 'CNT-'),
               ('journal', NULL, 'JV', 'JV-')) AS s(doc_type, channel, code, prefix)
 WHERE b.code = 'HQ';

-- ---------------------------------------------------------------------------------------------
-- Alerts
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sys.alerts (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_type       text NOT NULL CHECK (alert_type IN (
                     'low_stock', 'oversell_review', 'cash_drop_due', 'cash_variance',
                     'repeated_variance', 'drawer_left_open', 'backup_failed', 'backup_stale',
                     'restore_test_due', 'integrity_issue', 'audit_chain_broken', 'clock_skew',
                     'clock_backwards', 'period_missing')),
  severity         text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  entity_type      text,
  entity_id        text,
  params           jsonb NOT NULL DEFAULT '{}',
  dedupe_key       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,
  acknowledged_by  bigint REFERENCES auth.users (id),
  ack_note         text,
  CONSTRAINT alerts_ack_ck CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL))
);
CREATE UNIQUE INDEX alerts_open_dedupe_uq ON sys.alerts (dedupe_key) WHERE acknowledged_at IS NULL;
CREATE INDEX alerts_open_ix ON sys.alerts (created_at) WHERE acknowledged_at IS NULL;

CREATE FUNCTION sys.guard_alert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.acknowledged_at IS NOT NULL THEN
    RAISE EXCEPTION 'This alert was already acknowledged' USING ERRCODE = 'AP003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_alert BEFORE UPDATE ON sys.alerts FOR EACH ROW EXECUTE FUNCTION sys.guard_alert();
SELECT sys.add_immutable_guard('sys.alerts', '', '', 'acknowledged_at,acknowledged_by,ack_note');
SELECT audit.enable_for('sys.alerts');
SELECT sys.forbid_delete('sys.alerts');

-- ---------------------------------------------------------------------------------------------
-- Excel import batches
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sys.import_batches (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity         text NOT NULL CHECK (entity IN ('items', 'item_prices', 'customers', 'suppliers',
                                                 'opening_stock', 'opening_balances')),
  file_name      text NOT NULL,
  file_sha256    bytea NOT NULL CHECK (octet_length(file_sha256) = 32),
  status         text NOT NULL CHECK (status IN ('validated', 'rejected', 'committed')),
  rows_total     integer NOT NULL CHECK (rows_total >= 0),
  rows_valid     integer NOT NULL CHECK (rows_valid >= 0),
  rows_invalid   integer NOT NULL CHECK (rows_invalid >= 0),
  error_report   jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     bigint NOT NULL REFERENCES auth.users (id),
  committed_at   timestamptz,
  committed_by   bigint REFERENCES auth.users (id),
  CONSTRAINT import_rows_ck CHECK (rows_valid + rows_invalid = rows_total),
  CONSTRAINT import_commit_ck CHECK (
    (status = 'committed') = (committed_at IS NOT NULL AND committed_by IS NOT NULL))
);

CREATE FUNCTION sys.guard_import_batch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'validated' THEN
    RAISE EXCEPTION 'This import batch is already %', OLD.status USING ERRCODE = 'AP003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_import_batch BEFORE UPDATE ON sys.import_batches
  FOR EACH ROW EXECUTE FUNCTION sys.guard_import_batch();
SELECT sys.add_stamp('sys.import_batches');
SELECT sys.add_immutable_guard('sys.import_batches', '', '', 'status,committed_at,committed_by');
SELECT audit.enable_for('sys.import_batches');
SELECT sys.forbid_delete('sys.import_batches');

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON sys.company_profile TO artepool_api;
GRANT UPDATE (legal_name_ar, legal_name_en, trade_name_ar, trade_name_en, vat_registered, trn,
              address_ar, address_en, city, po_box, phone, email, website, emirate, logo, logo_mime)
  ON sys.company_profile TO artepool_api;
GRANT SELECT ON sys.settings TO artepool_api;
GRANT UPDATE (value) ON sys.settings TO artepool_api;
GRANT SELECT, INSERT ON sys.branches TO artepool_api;
GRANT UPDATE (code, name_ar, name_en, address_ar, address_en, is_active) ON sys.branches TO artepool_api;
GRANT SELECT ON sys.document_series TO artepool_api;
GRANT INSERT (doc_type, channel, branch_id, code, prefix, number_width, start_number, is_default, is_active)
  ON sys.document_series TO artepool_api;
GRANT UPDATE (is_default, is_active) ON sys.document_series TO artepool_api;
GRANT EXECUTE ON FUNCTION sys.next_number(bigint) TO artepool_api;
GRANT SELECT, INSERT ON sys.alerts TO artepool_api;
GRANT UPDATE (acknowledged_at, acknowledged_by, ack_note) ON sys.alerts TO artepool_api;
GRANT SELECT, INSERT ON sys.import_batches TO artepool_api;
GRANT UPDATE (status, committed_at, committed_by) ON sys.import_batches TO artepool_api;
