-- 0011_inventory.sql
-- Purpose: the stock ledger (docs/database-schema.md §8) and the M3 decisions:
--   0003 oversell adjustments with review; 0015 defective goods held at cost; 0040 stock values
--   only for stock.view_cost (API); 0041 approval above the threshold; 0042 opening stock by the
--   owner only (permission stock.opening); 0043 barcode label sizes; 0044 blind counts (API).
-- Stock on hand is never edited: every in or out is a row of inv.movements, and inv.balances is
-- written only by the movement trigger. The database refuses stock below zero, keeps the average
-- cost to 4 decimals, lets the exact remaining value leave with the last unit, and keeps the book
-- amounts (fils) equal to the rounded stock value with no drift (decision 0014).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0011: inventory (decisions 0003, 0015, 0040-0044)');

-- ---------------------------------------------------------------------------------------------
-- A business date must fall in an open month (decision 0016)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION gl.assert_period_open(p_date date) RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_id bigint;
  v_status text;
BEGIN
  SELECT id, status INTO v_id, v_status
    FROM gl.periods WHERE p_date BETWEEN period_start AND period_end;
  IF v_id IS NULL OR v_status <> 'open' THEN
    RAISE EXCEPTION 'The month of % is not open', p_date
      USING ERRCODE = 'AP011', HINT = 'PERIOD_NOT_OPEN', DETAIL = coalesce(v_status, 'missing');
  END IF;
  RETURN v_id;
END $$;

/** A whole-number setting (fils, counts). */
CREATE FUNCTION sys.setting_bigint(p_key text) RETURNS bigint
LANGUAGE sql STABLE AS $$ SELECT (value #>> '{}')::bigint FROM sys.settings WHERE key = p_key $$;

-- ---------------------------------------------------------------------------------------------
-- Reasons used by stock documents, and the owner-only opening-stock permission (0042)
-- ---------------------------------------------------------------------------------------------
INSERT INTO sys.reason_codes (category, code, name_ar, name_en, requires_note) VALUES
  ('stock_count', 'MISCOUNT', 'خطأ في العدّ السابق', 'Previous miscount', false),
  ('stock_count', 'DAMAGED', 'تلف', 'Damaged', false),
  ('stock_count', 'LOSS', 'فقد', 'Loss', true),
  ('stock_count', 'FOUND', 'وُجد', 'Found', false),
  ('stock_count', 'OTHER', 'أخرى', 'Other', true),
  ('write_off', 'SCRAPPED', 'تم التخلص منه', 'Scrapped', false),
  ('other', 'OPENING', 'رصيد افتتاحي', 'Opening stock', false);

INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('stock.opening', 'inventory', 'ترحيل الرصيد الافتتاحي', 'Post opening stock', true, false, true);
INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT id, 'stock.opening' FROM auth.roles WHERE code = 'owner';

-- ---------------------------------------------------------------------------------------------
-- Barcode label sizes (decision 0043): presets and the owner's own sizes; never deleted
-- ---------------------------------------------------------------------------------------------
CREATE TABLE md.label_sizes (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name_ar      text NOT NULL CHECK (btrim(name_ar) <> '' AND length(name_ar) <= 100),
  name_en      text NOT NULL CHECK (btrim(name_en) <> '' AND length(name_en) <= 100),
  width_mm     smallint NOT NULL CHECK (width_mm BETWEEN 10 AND 210),
  height_mm    smallint NOT NULL CHECK (height_mm BETWEEN 10 AND 297),
  sort_order   smallint NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 999),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint NOT NULL REFERENCES auth.users (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint NOT NULL REFERENCES auth.users (id),
  row_version  integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX label_sizes_code_uq ON md.label_sizes (lower(code));
SELECT sys.add_touch('md.label_sizes');
SELECT sys.add_deactivation_reason('md.label_sizes');
SELECT audit.enable_for('md.label_sizes');
SELECT sys.forbid_delete('md.label_sizes');

INSERT INTO md.label_sizes (code, name_ar, name_en, width_mm, height_mm, sort_order) VALUES
  ('25X15', 'صغير جدًا 25 × 15 مم', 'Extra small 25 × 15 mm', 25, 15, 1),
  ('30X20', 'صغير 30 × 20 مم', 'Small 30 × 20 mm', 30, 20, 2),
  ('38X25', 'قياسي 38 × 25 مم', 'Standard 38 × 25 mm', 38, 25, 3),
  ('40X30', 'متوسط 40 × 30 مم', 'Medium 40 × 30 mm', 40, 30, 4),
  ('50X25', 'عريض 50 × 25 مم', 'Wide 50 × 25 mm', 50, 25, 5),
  ('50X30', 'متوسط عريض 50 × 30 مم', 'Medium wide 50 × 30 mm', 50, 30, 6),
  ('58X40', 'كبير 58 × 40 مم', 'Large 58 × 40 mm', 58, 40, 7),
  ('100X50', 'كبير جدًا 100 × 50 مم', 'Extra large 100 × 50 mm', 100, 50, 8);

-- ---------------------------------------------------------------------------------------------
-- inv.balances: derived, written only by inv.apply_movement()
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inv.balances (
  item_id            bigint NOT NULL REFERENCES md.items (id),
  warehouse_id       bigint NOT NULL REFERENCES md.warehouses (id),
  stock_status       text NOT NULL CHECK (stock_status IN ('available', 'defective')),
  quantity           numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  value_4dp          bigint NOT NULL DEFAULT 0 CHECK (value_4dp >= 0),
  book_value_fils    bigint NOT NULL DEFAULT 0 CHECK (book_value_fils >= 0),
  avg_unit_cost_4dp  bigint CHECK (avg_unit_cost_4dp >= 0),
  last_movement_id   bigint,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, warehouse_id, stock_status),
  CONSTRAINT balances_empty_ck CHECK (quantity <> 0 OR value_4dp = 0)
);
CREATE INDEX balances_warehouse_ix ON inv.balances (warehouse_id);
SELECT sys.forbid_delete('inv.balances');

-- ---------------------------------------------------------------------------------------------
-- inv.adjustments (ADJ-) and their lines
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inv.adjustments (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid               uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  kind               text NOT NULL CHECK (kind IN
                       ('opening', 'increase', 'decrease', 'status_change', 'write_off', 'oversell')),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  series_id          bigint NOT NULL REFERENCES sys.document_series (id),
  seq_no             bigint,
  doc_number         text,
  warehouse_id       bigint NOT NULL REFERENCES md.warehouses (id),
  adjustment_date    date NOT NULL,
  reason_code_id     bigint NOT NULL REFERENCES sys.reason_codes (id),
  note               text CHECK (length(note) <= 1000),
  approval_id        bigint REFERENCES auth.approvals (id),
  sales_document_id  bigint, -- foreign key to sales.documents is added with the sales tables (M4)
  review_status      text NOT NULL DEFAULT 'not_required'
                       CHECK (review_status IN ('not_required', 'pending', 'reviewed')),
  reviewed_by        bigint REFERENCES auth.users (id),
  reviewed_at        timestamptz,
  review_note        text CHECK (review_note IS NULL OR length(btrim(review_note)) BETWEEN 3 AND 1000),
  import_batch_id    bigint REFERENCES sys.import_batches (id),
  total_value_fils   bigint,
  posted_at          timestamptz,
  posted_by          bigint REFERENCES auth.users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         bigint NOT NULL REFERENCES auth.users (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         bigint NOT NULL REFERENCES auth.users (id),
  row_version        integer NOT NULL DEFAULT 1,
  CONSTRAINT adjustments_number_uq UNIQUE (series_id, seq_no),
  CONSTRAINT adjustments_number_ck CHECK (
    (status = 'posted') = (seq_no IS NOT NULL) AND (seq_no IS NULL) = (doc_number IS NULL)),
  CONSTRAINT adjustments_posted_ck CHECK (
    (status = 'posted') = (posted_at IS NOT NULL AND posted_by IS NOT NULL AND total_value_fils IS NOT NULL)),
  CONSTRAINT adjustments_oversell_ck CHECK (
    (kind = 'oversell') = (sales_document_id IS NOT NULL)
    AND (kind = 'oversell') = (review_status <> 'not_required')
    AND (kind <> 'oversell' OR approval_id IS NOT NULL)),
  CONSTRAINT adjustments_review_ck CHECK (
    (review_status = 'reviewed') = (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_note IS NOT NULL))
);
CREATE INDEX adjustments_pending_ix ON inv.adjustments (created_at) WHERE review_status = 'pending';
CREATE INDEX adjustments_date_ix ON inv.adjustments (adjustment_date);

CREATE TABLE inv.adjustment_lines (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  adjustment_id          bigint NOT NULL REFERENCES inv.adjustments (id),
  line_no                smallint NOT NULL CHECK (line_no > 0),
  item_id                bigint NOT NULL REFERENCES md.items (id),
  stock_status           text NOT NULL DEFAULT 'available' CHECK (stock_status IN ('available', 'defective')),
  target_status          text CHECK (target_status IN ('available', 'defective')),
  quantity               numeric(14,3) NOT NULL CHECK (quantity > 0),
  entered_unit_cost_4dp  bigint CHECK (entered_unit_cost_4dp >= 0),
  value_4dp              bigint,
  value_fils             bigint,
  note                   text CHECK (length(note) <= 500),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             bigint NOT NULL REFERENCES auth.users (id),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             bigint NOT NULL REFERENCES auth.users (id),
  row_version            integer NOT NULL DEFAULT 1,
  CONSTRAINT adjustment_lines_no_uq UNIQUE (adjustment_id, line_no),
  CONSTRAINT adjustment_lines_target_ck CHECK (target_status IS NULL OR target_status <> stock_status)
);
CREATE INDEX adjustment_lines_item_ix ON inv.adjustment_lines (item_id);

-- ---------------------------------------------------------------------------------------------
-- inv.counts (CNT-) and their lines: blind while counting (decision 0044, enforced by the API)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inv.counts (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid               uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  series_id          bigint NOT NULL REFERENCES sys.document_series (id),
  seq_no             bigint,
  doc_number         text,
  warehouse_id       bigint NOT NULL REFERENCES md.warehouses (id),
  status             text NOT NULL DEFAULT 'counting'
                       CHECK (status IN ('draft', 'counting', 'posted', 'cancelled')),
  scope              text NOT NULL CHECK (scope IN ('full', 'category', 'selected')),
  category_id        bigint REFERENCES md.item_categories (id),
  snapshot_at        timestamptz,
  count_date         date,
  approval_id        bigint REFERENCES auth.approvals (id),
  note               text CHECK (length(note) <= 1000),
  total_value_fils   bigint,
  variance_abs_fils  bigint CHECK (variance_abs_fils >= 0),
  posted_at          timestamptz,
  posted_by          bigint REFERENCES auth.users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         bigint NOT NULL REFERENCES auth.users (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         bigint NOT NULL REFERENCES auth.users (id),
  row_version        integer NOT NULL DEFAULT 1,
  CONSTRAINT counts_number_uq UNIQUE (series_id, seq_no),
  CONSTRAINT counts_scope_ck CHECK ((scope = 'category') = (category_id IS NOT NULL)),
  CONSTRAINT counts_snapshot_ck CHECK (status = 'draft' OR status = 'cancelled' OR snapshot_at IS NOT NULL),
  CONSTRAINT counts_number_ck CHECK (
    (status = 'posted') = (seq_no IS NOT NULL) AND (seq_no IS NULL) = (doc_number IS NULL)),
  CONSTRAINT counts_posted_ck CHECK (
    (status = 'posted') = (posted_at IS NOT NULL AND posted_by IS NOT NULL
                           AND total_value_fils IS NOT NULL AND variance_abs_fils IS NOT NULL
                           AND count_date IS NOT NULL))
);
-- One open count per warehouse at a time, so two counts never fight over the same shelf.
CREATE UNIQUE INDEX counts_open_uq ON inv.counts (warehouse_id) WHERE status IN ('draft', 'counting');

CREATE TABLE inv.count_lines (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  count_id                 bigint NOT NULL REFERENCES inv.counts (id),
  item_id                  bigint NOT NULL REFERENCES md.items (id),
  stock_status             text NOT NULL DEFAULT 'available' CHECK (stock_status IN ('available', 'defective')),
  system_qty               numeric(14,3) NOT NULL CHECK (system_qty >= 0),
  counted_qty              numeric(14,3) CHECK (counted_qty >= 0),
  movement_since_snapshot  numeric(14,3),
  variance_qty             numeric(14,3),
  value_fils               bigint,
  counted_by               bigint REFERENCES auth.users (id),
  counted_at               timestamptz,
  reason_code_id           bigint REFERENCES sys.reason_codes (id),
  note                     text CHECK (length(note) <= 500),
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               bigint NOT NULL REFERENCES auth.users (id),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               bigint NOT NULL REFERENCES auth.users (id),
  row_version              integer NOT NULL DEFAULT 1,
  CONSTRAINT count_lines_item_uq UNIQUE (count_id, item_id, stock_status),
  CONSTRAINT count_lines_counted_ck CHECK ((counted_qty IS NULL) = (counted_at IS NULL)),
  CONSTRAINT count_lines_reason_ck CHECK (variance_qty IS NULL OR variance_qty = 0 OR reason_code_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------------------------
-- inv.movements: the append-only stock ledger
-- ---------------------------------------------------------------------------------------------
CREATE TABLE inv.movements (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  movement_type           text NOT NULL CHECK (movement_type IN (
                            'opening', 'sale', 'sale_return', 'adjustment_in', 'adjustment_out', 'oversell_in',
                            'status_out', 'status_in', 'write_off', 'count_gain', 'count_loss')),
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  movement_date           date NOT NULL,
  item_id                 bigint NOT NULL REFERENCES md.items (id),
  warehouse_id            bigint NOT NULL REFERENCES md.warehouses (id),
  stock_status            text NOT NULL CHECK (stock_status IN ('available', 'defective')),
  quantity                numeric(14,3) NOT NULL CHECK (quantity <> 0),
  value_4dp               bigint NOT NULL,
  value_fils              bigint NOT NULL,
  unit_cost_4dp           bigint NOT NULL CHECK (unit_cost_4dp >= 0),
  qty_after               numeric(14,3) NOT NULL CHECK (qty_after >= 0),
  value_after_4dp         bigint NOT NULL CHECK (value_after_4dp >= 0),
  sales_document_line_id  bigint, -- foreign key to sales.document_lines is added with the sales tables (M4)
  adjustment_line_id      bigint REFERENCES inv.adjustment_lines (id),
  count_line_id           bigint REFERENCES inv.count_lines (id),
  approval_id             bigint REFERENCES auth.approvals (id),
  reason_code_id          bigint REFERENCES sys.reason_codes (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              bigint NOT NULL REFERENCES auth.users (id),
  CONSTRAINT movements_source_ck CHECK (
    num_nonnulls(sales_document_line_id, adjustment_line_id, count_line_id) = 1
    AND CASE
          WHEN movement_type IN ('sale', 'sale_return') THEN sales_document_line_id IS NOT NULL
          WHEN movement_type IN ('count_gain', 'count_loss') THEN count_line_id IS NOT NULL
          ELSE adjustment_line_id IS NOT NULL
        END),
  CONSTRAINT movements_sign_ck CHECK (
    CASE WHEN movement_type IN ('opening', 'sale_return', 'adjustment_in', 'oversell_in', 'status_in', 'count_gain')
         THEN quantity > 0 ELSE quantity < 0 END),
  CONSTRAINT movements_value_sign_ck CHECK (
    (value_4dp = 0 OR sign(value_4dp) = sign(quantity))
    AND (value_fils = 0 OR sign(value_fils) = sign(quantity)))
);
CREATE INDEX movements_balance_ix ON inv.movements (item_id, warehouse_id, stock_status, id);
CREATE INDEX movements_date_ix ON inv.movements (movement_date);
CREATE INDEX movements_adjustment_line_ix ON inv.movements (adjustment_line_id) WHERE adjustment_line_id IS NOT NULL;
CREATE INDEX movements_count_line_ix ON inv.movements (count_line_id) WHERE count_line_id IS NOT NULL;

ALTER TABLE inv.balances ADD CONSTRAINT balances_last_movement_fk
  FOREIGN KEY (last_movement_id) REFERENCES inv.movements (id) DEFERRABLE INITIALLY DEFERRED;

-- The movement engine: values the movement and moves the balance, all under the balance's lock.
CREATE FUNCTION inv.apply_movement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  b inv.balances%ROWTYPE;
  v_after bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM md.items WHERE id = NEW.item_id AND item_type = 'stock') THEN
    RAISE EXCEPTION 'Only stock items have stock' USING ERRCODE = 'AP011', HINT = 'STOCK_ITEM_ONLY';
  END IF;
  PERFORM gl.assert_period_open(NEW.movement_date);
  NEW.occurred_at := now();

  INSERT INTO inv.balances (item_id, warehouse_id, stock_status)
  VALUES (NEW.item_id, NEW.warehouse_id, NEW.stock_status)
  ON CONFLICT DO NOTHING;
  SELECT * INTO b FROM inv.balances
   WHERE item_id = NEW.item_id AND warehouse_id = NEW.warehouse_id AND stock_status = NEW.stock_status
     FOR UPDATE;

  IF NEW.quantity < 0 THEN
    IF b.quantity + NEW.quantity < 0 THEN
      RAISE EXCEPTION 'Not enough stock: % on hand, % asked', b.quantity, -NEW.quantity
        USING ERRCODE = 'AP011', HINT = 'STOCK_INSUFFICIENT', DETAIL = b.quantity::text;
    END IF;
    -- Outbound: the average share of the value; the last unit takes exactly what remains.
    NEW.value_4dp := CASE
      WHEN b.quantity + NEW.quantity = 0 THEN -b.value_4dp
      ELSE -sys.round_div(b.value_4dp * (-NEW.quantity * 1000), b.quantity * 1000)
    END;
  ELSIF NEW.value_4dp IS NULL OR NEW.value_4dp < 0 THEN
    RAISE EXCEPTION 'An incoming movement needs its value' USING ERRCODE = 'AP011', HINT = 'MOVEMENT_VALUE_REQUIRED';
  END IF;

  v_after := b.value_4dp + NEW.value_4dp;
  NEW.qty_after := b.quantity + NEW.quantity;
  NEW.value_after_4dp := v_after;
  -- The books move by the change in the rounded running value: they never drift from the stock.
  NEW.value_fils := sys.round_div(v_after, 100) - sys.round_div(b.value_4dp, 100);
  NEW.unit_cost_4dp := sys.round_div(abs(NEW.value_4dp) * 1000, abs(NEW.quantity) * 1000);

  UPDATE inv.balances
     SET quantity = NEW.qty_after,
         value_4dp = v_after,
         book_value_fils = sys.round_div(v_after, 100),
         avg_unit_cost_4dp = CASE WHEN NEW.qty_after > 0
                                  THEN sys.round_div(v_after * 1000, NEW.qty_after * 1000)
                                  ELSE b.avg_unit_cost_4dp END,
         last_movement_id = NEW.id,
         updated_at = now()
   WHERE item_id = NEW.item_id AND warehouse_id = NEW.warehouse_id AND stock_status = NEW.stock_status;
  RETURN NEW;
END $$;
CREATE TRIGGER b_apply_movement BEFORE INSERT ON inv.movements
  FOR EACH ROW EXECUTE FUNCTION inv.apply_movement();
SELECT sys.add_stamp('inv.movements');
SELECT sys.add_immutable_guard('inv.movements', '', '', '');
SELECT audit.enable_for('inv.movements');
SELECT sys.forbid_delete('inv.movements');

-- ---------------------------------------------------------------------------------------------
-- Adjustment rules: numbered when posted, final after posting (only the review may change)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION inv.series_for(p_doc_type text, p_warehouse_id bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT s.id FROM sys.document_series s
    JOIN md.warehouses w ON w.branch_id = s.branch_id
   WHERE w.id = p_warehouse_id AND s.doc_type = p_doc_type AND s.is_default AND s.is_active
$$;

CREATE FUNCTION inv.adjustment_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_category text;
  v_expected text;
  v_number record;
  v_threshold bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'An adjustment starts as a draft' USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
    END IF;
    NEW.series_id := coalesce(NEW.series_id, inv.series_for('stock_adjustment', NEW.warehouse_id));
    NEW.review_status := CASE WHEN NEW.kind = 'oversell' THEN 'pending' ELSE 'not_required' END;
  END IF;

  -- The reason must belong to the kind of adjustment.
  SELECT category INTO v_category FROM sys.reason_codes WHERE id = NEW.reason_code_id;
  v_expected := CASE NEW.kind
    WHEN 'opening' THEN 'other' WHEN 'increase' THEN 'stock_increase' WHEN 'decrease' THEN 'stock_decrease'
    WHEN 'status_change' THEN 'defective' WHEN 'write_off' THEN 'write_off' ELSE 'oversell' END;
  IF v_category IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'This reason does not fit a % adjustment', NEW.kind
      USING ERRCODE = 'AP011', HINT = 'ADJUSTMENT_REASON';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'posted' THEN
    PERFORM gl.assert_period_open(NEW.adjustment_date);
    IF NOT EXISTS (SELECT 1 FROM inv.adjustment_lines WHERE adjustment_id = NEW.id) THEN
      RAISE EXCEPTION 'An adjustment needs at least one line' USING ERRCODE = 'AP011', HINT = 'ADJUSTMENT_EMPTY';
    END IF;
    IF NEW.kind = 'opening' AND NOT auth.user_has_permission(sys.require_user(), 'stock.opening') THEN
      RAISE EXCEPTION 'Only the owner posts opening stock' USING ERRCODE = 'AP012', HINT = 'OPENING_OWNER_ONLY';
    END IF;
    -- Decision 0041: a large change needs a supervisor's approval.
    v_threshold := sys.setting_bigint('inventory.adjustment_approval_threshold_fils');
    IF NEW.kind IN ('increase', 'decrease', 'write_off') AND abs(NEW.total_value_fils) > v_threshold
       AND NEW.approval_id IS NULL THEN
      RAISE EXCEPTION 'This adjustment is worth more than the approval threshold'
        USING ERRCODE = 'AP012', HINT = 'APPROVAL_REQUIRED', DETAIL = v_threshold::text;
    END IF;
    SELECT * INTO v_number FROM sys.next_number(NEW.series_id);
    NEW.seq_no := v_number.seq_no;
    NEW.doc_number := v_number.formatted;
    NEW.posted_at := now();
    NEW.posted_by := sys.require_user();
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
        AND NOT (OLD.status = 'draft' AND NEW.status = 'cancelled') THEN
    RAISE EXCEPTION 'An adjustment goes from draft to posted or cancelled only'
      USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
  END IF;

  -- Oversell review (decision 0003): pending → reviewed, once, with a note; who and when are stamped.
  IF TG_OP = 'UPDATE' AND NEW.review_status IS DISTINCT FROM OLD.review_status THEN
    IF NOT (OLD.review_status = 'pending' AND NEW.review_status = 'reviewed' AND OLD.status = 'posted') THEN
      RAISE EXCEPTION 'Only a posted, pending oversell can be marked reviewed'
        USING ERRCODE = 'AP011', HINT = 'REVIEW_STEP';
    END IF;
    NEW.reviewed_by := sys.require_user();
    NEW.reviewed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_adjustment_rules BEFORE INSERT OR UPDATE ON inv.adjustments
  FOR EACH ROW EXECUTE FUNCTION inv.adjustment_rules();
SELECT sys.add_touch('inv.adjustments');
SELECT sys.add_immutable_guard('inv.adjustments', 'status', 'draft',
                               'review_status,reviewed_by,reviewed_at,review_note');
SELECT audit.enable_for('inv.adjustments');
SELECT sys.forbid_delete('inv.adjustments');

CREATE FUNCTION inv.adjustment_line_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
BEGIN
  SELECT kind INTO v_kind FROM inv.adjustments WHERE id = NEW.adjustment_id;
  IF NOT EXISTS (SELECT 1 FROM md.items WHERE id = NEW.item_id AND item_type = 'stock') THEN
    RAISE EXCEPTION 'Only stock items have stock' USING ERRCODE = 'AP011', HINT = 'STOCK_ITEM_ONLY';
  END IF;
  IF (v_kind = 'status_change') <> (NEW.target_status IS NOT NULL) THEN
    RAISE EXCEPTION 'Only a status change has a target status' USING ERRCODE = 'AP011', HINT = 'ADJUSTMENT_LINE';
  END IF;
  -- Defective goods are written off; new stock arrives sellable.
  IF (v_kind = 'write_off' AND NEW.stock_status <> 'defective')
     OR (v_kind IN ('opening', 'increase', 'oversell') AND NEW.stock_status <> 'available') THEN
    RAISE EXCEPTION 'Wrong stock status for a % adjustment', v_kind USING ERRCODE = 'AP011', HINT = 'ADJUSTMENT_LINE';
  END IF;
  IF v_kind IN ('opening', 'increase', 'oversell') AND NEW.entered_unit_cost_4dp IS NULL THEN
    RAISE EXCEPTION 'Incoming stock needs a unit cost' USING ERRCODE = 'AP011', HINT = 'COST_UNKNOWN';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_adjustment_line_rules BEFORE INSERT OR UPDATE OF item_id, stock_status, target_status,
  entered_unit_cost_4dp ON inv.adjustment_lines FOR EACH ROW EXECUTE FUNCTION inv.adjustment_line_rules();
CREATE TRIGGER guard_draft_lines BEFORE INSERT OR UPDATE OR DELETE ON inv.adjustment_lines
  FOR EACH ROW EXECUTE FUNCTION sys.guard_draft_lines('inv.adjustments', 'adjustment_id', 'status', 'draft');
SELECT sys.add_touch('inv.adjustment_lines');
SELECT audit.enable_for('inv.adjustment_lines');
SELECT sys.forbid_delete('inv.adjustment_lines');

-- ---------------------------------------------------------------------------------------------
-- Count rules: the snapshot is taken when counting starts; numbered and final when posted
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION inv.count_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_number record;
  v_threshold bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('draft', 'counting') THEN
      RAISE EXCEPTION 'A count starts as a draft or counting' USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
    END IF;
    NEW.series_id := coalesce(NEW.series_id, inv.series_for('stock_count', NEW.warehouse_id));
  END IF;
  IF NEW.status = 'counting' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    NEW.snapshot_at := now();
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status IN ('counting', 'cancelled'))
            OR (OLD.status = 'counting' AND NEW.status IN ('posted', 'cancelled'))) THEN
      RAISE EXCEPTION 'A count goes draft → counting → posted, or is cancelled before posting'
        USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
    END IF;
    IF NEW.status = 'posted' THEN
      PERFORM gl.assert_period_open(NEW.count_date);
      IF EXISTS (SELECT 1 FROM inv.count_lines WHERE count_id = NEW.id AND counted_qty IS NULL) THEN
        RAISE EXCEPTION 'Every line must be counted before posting' USING ERRCODE = 'AP011', HINT = 'COUNT_INCOMPLETE';
      END IF;
      v_threshold := sys.setting_bigint('inventory.adjustment_approval_threshold_fils');
      IF NEW.variance_abs_fils > v_threshold AND NEW.approval_id IS NULL THEN
        RAISE EXCEPTION 'The count differences are worth more than the approval threshold'
          USING ERRCODE = 'AP012', HINT = 'APPROVAL_REQUIRED', DETAIL = v_threshold::text;
      END IF;
      SELECT * INTO v_number FROM sys.next_number(NEW.series_id);
      NEW.seq_no := v_number.seq_no;
      NEW.doc_number := v_number.formatted;
      NEW.posted_at := now();
      NEW.posted_by := sys.require_user();
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_count_rules BEFORE INSERT OR UPDATE ON inv.counts
  FOR EACH ROW EXECUTE FUNCTION inv.count_rules();
SELECT sys.add_touch('inv.counts');
SELECT sys.add_immutable_guard('inv.counts', 'status', 'draft,counting', '');
SELECT audit.enable_for('inv.counts');
SELECT sys.forbid_delete('inv.counts');

-- Who counted and when are stamped by the database.
CREATE FUNCTION inv.count_line_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.counted_qty IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.counted_qty END) THEN
    NEW.counted_by := CASE WHEN NEW.counted_qty IS NULL THEN NULL ELSE sys.require_user() END;
    NEW.counted_at := CASE WHEN NEW.counted_qty IS NULL THEN NULL ELSE now() END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_count_line_rules BEFORE INSERT OR UPDATE ON inv.count_lines
  FOR EACH ROW EXECUTE FUNCTION inv.count_line_rules();
CREATE TRIGGER guard_draft_lines BEFORE INSERT OR UPDATE OR DELETE ON inv.count_lines
  FOR EACH ROW EXECUTE FUNCTION sys.guard_draft_lines('inv.counts', 'count_id', 'status', 'draft,counting');
SELECT sys.add_touch('inv.count_lines');
SELECT audit.enable_for('inv.count_lines');
SELECT sys.forbid_delete('inv.count_lines');

-- ---------------------------------------------------------------------------------------------
-- Grants: the API inserts movements (the trigger values them) and never writes balances
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON inv.movements, inv.balances, inv.adjustments, inv.adjustment_lines, inv.counts,
                inv.count_lines, md.label_sizes TO artepool_api;
GRANT INSERT (movement_type, movement_date, item_id, warehouse_id, stock_status, quantity, value_4dp,
              sales_document_line_id, adjustment_line_id, count_line_id, approval_id, reason_code_id)
  ON inv.movements TO artepool_api;
GRANT INSERT (kind, warehouse_id, adjustment_date, reason_code_id, note, approval_id, sales_document_id,
              import_batch_id)
  ON inv.adjustments TO artepool_api;
GRANT UPDATE (status, total_value_fils, approval_id, note, review_status, review_note)
  ON inv.adjustments TO artepool_api;
GRANT INSERT (adjustment_id, line_no, item_id, stock_status, target_status, quantity, entered_unit_cost_4dp, note)
  ON inv.adjustment_lines TO artepool_api;
GRANT UPDATE (value_4dp, value_fils) ON inv.adjustment_lines TO artepool_api;
GRANT INSERT (warehouse_id, status, scope, category_id, note) ON inv.counts TO artepool_api;
GRANT UPDATE (status, approval_id, note, count_date, total_value_fils, variance_abs_fils)
  ON inv.counts TO artepool_api;
GRANT INSERT (count_id, item_id, stock_status, system_qty) ON inv.count_lines TO artepool_api;
GRANT UPDATE (counted_qty, reason_code_id, note, movement_since_snapshot, variance_qty, value_fils)
  ON inv.count_lines TO artepool_api;
GRANT INSERT (code, name_ar, name_en, width_mm, height_mm, sort_order, is_active) ON md.label_sizes TO artepool_api;
GRANT UPDATE (name_ar, name_en, width_mm, height_mm, sort_order, is_active) ON md.label_sizes TO artepool_api;
GRANT EXECUTE ON FUNCTION gl.assert_period_open(date), sys.setting_bigint(text),
                          inv.series_for(text, bigint) TO artepool_api;
