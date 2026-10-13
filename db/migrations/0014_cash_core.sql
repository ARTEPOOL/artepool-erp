-- 0014_cash_core.sql
-- Purpose: the cash drawer core (docs/database-schema.md §10.1–10.4): registers, shifts, counts
-- and their lines. M4 needs them because a POS sale document refers to its register and shift;
-- the POS screens, the close and the Z report come in M5 (decisions 0004, 0006).
-- One cashier per drawer shift (0004): a register has at most one open shift, a cashier at most
-- one, and only that cashier works on it (cash.assert_shift_owner).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0014: cash core (decisions 0004, 0006)');

-- ---------------------------------------------------------------------------------------------
-- Registers (a drawer, usually on one POS PC)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE cash.registers (
  id                                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                              text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9._-]{1,32}$'),
  name_ar                           text NOT NULL CHECK (btrim(name_ar) <> '' AND length(name_ar) <= 100),
  name_en                           text NOT NULL CHECK (btrim(name_en) <> '' AND length(name_en) <= 100),
  branch_id                         bigint NOT NULL REFERENCES sys.branches (id),
  device_id                         bigint UNIQUE REFERENCES auth.devices (id),
  warehouse_id                      bigint NOT NULL REFERENCES md.warehouses (id),
  invoice_series_id                 bigint NOT NULL REFERENCES sys.document_series (id),
  receipt_series_id                 bigint NOT NULL REFERENCES sys.document_series (id),
  drop_threshold_fils               bigint NOT NULL CHECK (drop_threshold_fils > 0),
  variance_approval_threshold_fils  bigint NOT NULL DEFAULT 0 CHECK (variance_approval_threshold_fils >= 0),
  drawer_status_supported           boolean NOT NULL DEFAULT false,
  is_active                         boolean NOT NULL DEFAULT true,
  deactivation_reason               text CHECK (deactivation_reason IS NULL OR length(btrim(deactivation_reason)) BETWEEN 3 AND 500),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  created_by                        bigint NOT NULL REFERENCES auth.users (id),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  updated_by                        bigint NOT NULL REFERENCES auth.users (id),
  row_version                       integer NOT NULL DEFAULT 1,
  CONSTRAINT registers_deactivation_ck CHECK (is_active OR deactivation_reason IS NOT NULL)
);

-- A register sells on the POS invoice series (POS-) and receives on the receipt series.
CREATE FUNCTION cash.register_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sys.document_series
                  WHERE id = NEW.invoice_series_id AND doc_type = 'invoice' AND channel = 'pos') THEN
    RAISE EXCEPTION 'A register sells on the POS invoice series' USING ERRCODE = 'AP011', HINT = 'SERIES_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sys.document_series
                  WHERE id = NEW.receipt_series_id AND doc_type = 'receipt') THEN
    RAISE EXCEPTION 'A register receives on the receipt series' USING ERRCODE = 'AP011', HINT = 'SERIES_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_register_rules BEFORE INSERT OR UPDATE OF invoice_series_id, receipt_series_id
  ON cash.registers FOR EACH ROW EXECUTE FUNCTION cash.register_rules();
SELECT sys.add_touch('cash.registers');
SELECT audit.enable_for('cash.registers');
SELECT sys.forbid_delete('cash.registers');

-- ---------------------------------------------------------------------------------------------
-- Shifts (Z-): one cashier per drawer shift; closed shifts never change
-- ---------------------------------------------------------------------------------------------
CREATE TABLE cash.shifts (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid                      uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  series_id                 bigint NOT NULL REFERENCES sys.document_series (id),
  seq_no                    bigint NOT NULL,
  shift_number              text NOT NULL,
  register_id               bigint NOT NULL REFERENCES cash.registers (id),
  cashier_id                bigint NOT NULL REFERENCES auth.users (id),
  status                    text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at                 timestamptz NOT NULL DEFAULT now(),
  opened_by                 bigint NOT NULL REFERENCES auth.users (id),
  opening_float_fils        bigint NOT NULL CHECK (opening_float_fils >= 0),
  opening_count_id          bigint, -- foreign key to cash.counts added below
  closed_at                 timestamptz,
  closed_by                 bigint REFERENCES auth.users (id),
  closing_count_id          bigint, -- foreign key to cash.counts added below
  expected_cash_fils        bigint,
  counted_cash_fils         bigint,
  variance_fils             bigint,
  variance_reason_code_id   bigint REFERENCES sys.reason_codes (id),
  variance_note             text CHECK (length(variance_note) <= 1000),
  approval_id               bigint REFERENCES auth.approvals (id),
  z_snapshot                jsonb,
  audit_anchor_seq          bigint,
  audit_anchor_hash         bytea,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                bigint NOT NULL REFERENCES auth.users (id),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                bigint NOT NULL REFERENCES auth.users (id),
  row_version               integer NOT NULL DEFAULT 1,
  CONSTRAINT shifts_number_uq UNIQUE (series_id, seq_no),
  CONSTRAINT shifts_opener_ck CHECK (opened_by = cashier_id),
  CONSTRAINT shifts_closed_ck CHECK ((status = 'closed') = (num_nulls(closed_at, closed_by, closing_count_id,
    expected_cash_fils, counted_cash_fils, variance_fils, z_snapshot) = 0)),
  CONSTRAINT shifts_variance_ck CHECK (variance_fils IS NULL OR variance_fils = counted_cash_fils - expected_cash_fils)
);
CREATE UNIQUE INDEX shifts_open_register_uq ON cash.shifts (register_id) WHERE status = 'open';
CREATE UNIQUE INDEX shifts_open_cashier_uq ON cash.shifts (cashier_id) WHERE status = 'open';

-- Opening: numbered from the Z- series; the person opening is the cashier, the register is active.
CREATE FUNCTION cash.shift_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_number record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'A shift starts open' USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cash.registers WHERE id = NEW.register_id AND is_active) THEN
      RAISE EXCEPTION 'This register is not active' USING ERRCODE = 'AP011', HINT = 'REGISTER_INACTIVE';
    END IF;
    NEW.opened_by := sys.require_user();
    NEW.cashier_id := NEW.opened_by;
    NEW.opened_at := now();
    NEW.series_id := (SELECT id FROM sys.document_series WHERE doc_type = 'shift' ORDER BY id LIMIT 1);
    SELECT * INTO v_number FROM sys.next_number(NEW.series_id);
    NEW.seq_no := v_number.seq_no;
    NEW.shift_number := v_number.formatted;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (OLD.status = 'open' AND NEW.status = 'closed') THEN
      RAISE EXCEPTION 'A closed shift cannot be reopened' USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
    END IF;
    NEW.closed_at := now();
    NEW.closed_by := sys.require_user();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_shift_rules BEFORE INSERT OR UPDATE ON cash.shifts
  FOR EACH ROW EXECUTE FUNCTION cash.shift_rules();
SELECT sys.add_touch('cash.shifts');
SELECT audit.enable_for('cash.shifts');
SELECT sys.forbid_delete('cash.shifts');
SELECT sys.add_immutable_guard('cash.shifts', 'status', 'open', '');

/** Decision 0004: only the shift's own cashier works on an open shift. Returns its register. */
CREATE FUNCTION cash.assert_shift_owner(p_shift_id bigint) RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  s record;
BEGIN
  SELECT status, cashier_id, register_id INTO s FROM cash.shifts WHERE id = p_shift_id;
  IF s.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'This shift is not open' USING ERRCODE = 'AP011', HINT = 'SHIFT_NOT_OPEN';
  END IF;
  IF s.cashier_id <> sys.require_user() THEN
    RAISE EXCEPTION 'Only the shift''s own cashier works on it' USING ERRCODE = 'AP012', HINT = 'SHIFT_NOT_OWNER';
  END IF;
  RETURN s.register_id;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Counts and their lines (append-only); at most one closing count and one recount (0006)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE cash.counts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id       bigint NOT NULL REFERENCES cash.shifts (id),
  purpose        text NOT NULL CHECK (purpose IN ('opening', 'closing', 'drop', 'spot_check')),
  total_fils     bigint NOT NULL CHECK (total_fils >= 0),
  supersedes_id  bigint REFERENCES cash.counts (id),
  approval_id    bigint REFERENCES auth.approvals (id),
  counted_by     bigint NOT NULL REFERENCES auth.users (id),
  counted_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT counts_recount_ck CHECK (supersedes_id IS NULL OR (approval_id IS NOT NULL AND purpose = 'closing'))
);
CREATE UNIQUE INDEX counts_closing_uq ON cash.counts (shift_id) WHERE purpose = 'closing' AND supersedes_id IS NULL;
CREATE UNIQUE INDEX counts_recount_uq ON cash.counts (shift_id) WHERE purpose = 'closing' AND supersedes_id IS NOT NULL;
SELECT sys.add_stamp('cash.counts', 'counted_at', 'counted_by');
SELECT audit.enable_for('cash.counts');
SELECT sys.forbid_delete('cash.counts');
SELECT sys.add_immutable_guard('cash.counts', '', '', '');

ALTER TABLE cash.shifts
  ADD CONSTRAINT shifts_opening_count_fk FOREIGN KEY (opening_count_id) REFERENCES cash.counts (id),
  ADD CONSTRAINT shifts_closing_count_fk FOREIGN KEY (closing_count_id) REFERENCES cash.counts (id);

CREATE TABLE cash.count_lines (
  count_id         bigint NOT NULL REFERENCES cash.counts (id),
  denomination_id  bigint NOT NULL REFERENCES md.cash_denominations (id),
  quantity         integer NOT NULL CHECK (quantity >= 0),
  amount_fils      bigint NOT NULL CHECK (amount_fils >= 0),
  PRIMARY KEY (count_id, denomination_id)
);

-- A line's amount is the denomination × the quantity, worked out by the database.
CREATE FUNCTION cash.count_line_amount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.amount_fils := NEW.quantity * (SELECT value_fils FROM md.cash_denominations WHERE id = NEW.denomination_id);
  RETURN NEW;
END $$;
CREATE TRIGGER b_count_line_amount BEFORE INSERT ON cash.count_lines
  FOR EACH ROW EXECUTE FUNCTION cash.count_line_amount();

-- The count's total equals its lines, checked at commit.
CREATE FUNCTION cash.count_total_matches() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_count_id bigint := coalesce((to_jsonb(NEW) ->> 'count_id')::bigint, (to_jsonb(NEW) ->> 'id')::bigint);
BEGIN
  IF (SELECT total_fils FROM cash.counts WHERE id = v_count_id)
     <> (SELECT coalesce(sum(amount_fils), 0) FROM cash.count_lines WHERE count_id = v_count_id) THEN
    RAISE EXCEPTION 'A count''s total must equal its lines' USING ERRCODE = 'AP011', HINT = 'COUNT_TOTAL';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER z_count_total AFTER INSERT ON cash.counts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash.count_total_matches();
CREATE CONSTRAINT TRIGGER z_count_total AFTER INSERT ON cash.count_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash.count_total_matches();
SELECT audit.enable_for('cash.count_lines');
SELECT sys.forbid_delete('cash.count_lines');
SELECT sys.add_immutable_guard('cash.count_lines', '', '', '');

-- ---------------------------------------------------------------------------------------------
-- Grants (the POS API arrives in M5; it opens shifts and records counts)
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON cash.registers, cash.shifts, cash.counts, cash.count_lines TO artepool_api;
GRANT INSERT (code, name_ar, name_en, branch_id, device_id, warehouse_id, invoice_series_id, receipt_series_id,
              drop_threshold_fils, variance_approval_threshold_fils, drawer_status_supported, is_active)
  ON cash.registers TO artepool_api;
GRANT UPDATE (name_ar, name_en, device_id, warehouse_id, drop_threshold_fils, variance_approval_threshold_fils,
              drawer_status_supported, is_active, deactivation_reason)
  ON cash.registers TO artepool_api;
GRANT INSERT (register_id, opening_float_fils, opening_count_id) ON cash.shifts TO artepool_api;
GRANT UPDATE (status, opening_count_id, closing_count_id, expected_cash_fils, counted_cash_fils, variance_fils,
              variance_reason_code_id, variance_note, approval_id, z_snapshot, audit_anchor_seq, audit_anchor_hash)
  ON cash.shifts TO artepool_api;
GRANT INSERT (shift_id, purpose, total_fils, supersedes_id, approval_id) ON cash.counts TO artepool_api;
GRANT INSERT (count_id, denomination_id, quantity) ON cash.count_lines TO artepool_api;
GRANT EXECUTE ON FUNCTION cash.assert_shift_owner(bigint) TO artepool_api;
