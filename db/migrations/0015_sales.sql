-- 0015_sales.sql
-- Purpose: quotations, tax documents, payments and their allocations, customer opening balances
-- and held carts (docs/database-schema.md §9), with the M4 decisions 0045–0052.
-- The database is the last line of defence for the money rules:
--   * every line's amounts are worked out here from its inputs, with the same formulas as the
--     shared helper (VAT per line 0009, discounts before VAT 0012, half away from zero 0014);
--   * numbers are given at issue, gapless, and POS-/INV- are never mixed (0011);
--   * a full tax invoice exactly when the customer is VAT-registered, with its TRN (0010);
--   * issued documents never change; corrections are credit or debit notes;
--   * an advance deduction never takes more than remains, nor from another customer (0013);
--   * every receipt is fully allocated at commit (0013, 0052);
--   * an unpaid invoice beyond the customer's credit needs an approval (0046);
--   * every issued document, payment and opening balance has its journal entry at commit, and
--     every stock line its movement (one transaction per business operation).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0015: sales (decisions 0009-0013, 0045-0052)');

-- ---------------------------------------------------------------------------------------------
-- Settings, permission, reasons, office cash account (0047, 0049, 0051)
-- ---------------------------------------------------------------------------------------------
INSERT INTO sys.settings (key, value, description) VALUES
  ('sales.quotation_valid_days', '15', 'Days a new quotation stays valid (decision 0049)');

INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('customers.opening', 'sales', 'إدخال الأرصدة الافتتاحية للعملاء', 'Enter customer opening balances',
        true, false, true);
INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT id, 'customers.opening' FROM auth.roles WHERE code = 'owner';

INSERT INTO sys.reason_codes (category, code, name_ar, name_en, requires_note) VALUES
  ('credit_note', 'CANCELLED_WORK', 'إلغاء أعمال', 'Work cancelled', true),
  ('debit_note', 'PRICE_ADJ', 'تعديل سعر', 'Price adjustment', true),
  ('debit_note', 'EXTRA_WORK', 'أعمال إضافية', 'Extra work', true),
  ('payment_reversal', 'ENTRY_ERROR', 'خطأ في التسجيل', 'Entry error', true),
  ('other', 'OPENING_BALANCE', 'رصيد افتتاحي', 'Opening balance', false);

-- Cash received in the office goes to Cash in safe, not to a POS drawer (decision 0047).
ALTER TABLE md.payment_methods ADD COLUMN office_gl_account_id bigint REFERENCES gl.accounts (id);
UPDATE md.payment_methods
   SET office_gl_account_id = (SELECT account_id FROM gl.account_mappings WHERE key = 'cash_in_safe')
 WHERE kind = 'cash';
GRANT UPDATE (office_gl_account_id) ON md.payment_methods TO artepool_api;
GRANT INSERT (office_gl_account_id) ON md.payment_methods TO artepool_api;

-- ---------------------------------------------------------------------------------------------
-- Line arithmetic (the shared helper's computeLine, in SQL)
-- ---------------------------------------------------------------------------------------------
/**
 * One line: quantity (3 dp) × unit price (4 dp) → fils; discounts before VAT; VAT per line,
 * added to a net price or found inside an inclusive one. Same results as computeLine().
 */
CREATE FUNCTION sales.line_amounts(p_quantity numeric, p_unit_price_4dp bigint, p_includes_vat boolean,
                                   p_rate_bp integer, p_line_discount_fils bigint, p_doc_alloc_fils bigint,
                                   OUT amount_before_fils bigint, OUT net_fils bigint, OUT vat_fils bigint,
                                   OUT gross_fils bigint, OUT discount_excl_vat_fils bigint)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_discount bigint := p_line_discount_fils + p_doc_alloc_fils;
  v_after bigint;
BEGIN
  amount_before_fils := sys.round_div(round(p_quantity * 1000) * p_unit_price_4dp, 100000);
  IF v_discount > amount_before_fils THEN
    RAISE EXCEPTION 'The discount is larger than the line amount' USING ERRCODE = 'AP011', HINT = 'DISCOUNT_TOO_LARGE';
  END IF;
  v_after := amount_before_fils - v_discount;
  IF p_includes_vat THEN
    gross_fils := v_after;
    vat_fils := sys.round_div(gross_fils * p_rate_bp, 10000 + p_rate_bp);
    net_fils := gross_fils - vat_fils;
    discount_excl_vat_fils := v_discount - sys.round_div(v_discount * p_rate_bp, 10000 + p_rate_bp);
  ELSE
    net_fils := v_after;
    vat_fils := sys.round_div(net_fils * p_rate_bp, 10000);
    gross_fils := net_fils + vat_fils;
    discount_excl_vat_fils := v_discount;
  END IF;
END $$;

/** The document series for a kind of document and channel (POS- and INV- are separate, 0011). */
CREATE FUNCTION sales.series_for(p_doc_type text, p_channel text) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT id FROM sys.document_series
   WHERE doc_type = CASE WHEN p_doc_type = 'advance_invoice' THEN 'invoice' ELSE p_doc_type END
     AND (channel IS NULL OR channel = p_channel)
   ORDER BY channel NULLS LAST, id
   LIMIT 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Quotations (Q-): numbered at first save; editable while draft; revisions after sent (0049)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sales.quotations (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid                   uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  series_id              bigint NOT NULL REFERENCES sys.document_series (id),
  seq_no                 bigint NOT NULL,
  doc_number             text NOT NULL,
  revision               smallint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  revised_from_id        bigint UNIQUE REFERENCES sales.quotations (id),
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN
                           ('draft', 'sent', 'accepted', 'rejected', 'expired', 'converted', 'cancelled', 'superseded')),
  branch_id              bigint NOT NULL REFERENCES sys.branches (id),
  business_line_id       bigint NOT NULL REFERENCES md.business_lines (id),
  customer_id            bigint NOT NULL REFERENCES md.customers (id),
  bill_to_name           text NOT NULL CHECK (btrim(bill_to_name) <> ''),
  bill_to_name_alt       text,
  bill_to_trn            char(15),
  bill_to_address        text,
  bill_to_phone          text,
  quotation_date         date NOT NULL,
  valid_until            date NOT NULL,
  price_level_id         bigint NOT NULL REFERENCES md.price_levels (id),
  salesperson_id         bigint REFERENCES auth.users (id),
  subject                text CHECK (length(subject) <= 300),
  terms_ar               text CHECK (length(terms_ar) <= 4000),
  terms_en               text CHECK (length(terms_en) <= 4000),
  notes                  text CHECK (length(notes) <= 2000),
  doc_discount_fils      bigint NOT NULL DEFAULT 0 CHECK (doc_discount_fils >= 0),
  discount_total_fils    bigint NOT NULL DEFAULT 0 CHECK (discount_total_fils >= 0),
  net_fils               bigint NOT NULL DEFAULT 0 CHECK (net_fils >= 0),
  vat_fils               bigint NOT NULL DEFAULT 0 CHECK (vat_fils >= 0),
  total_fils             bigint NOT NULL DEFAULT 0 CHECK (total_fils >= 0),
  approval_id            bigint REFERENCES auth.approvals (id),
  converted_document_id  bigint, -- foreign key to sales.documents added below
  sent_at                timestamptz,
  decided_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             bigint NOT NULL REFERENCES auth.users (id),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             bigint NOT NULL REFERENCES auth.users (id),
  row_version            integer NOT NULL DEFAULT 1,
  CONSTRAINT quotations_number_uq UNIQUE (series_id, seq_no, revision),
  CONSTRAINT quotations_valid_ck CHECK (valid_until >= quotation_date),
  CONSTRAINT quotations_total_ck CHECK (total_fils = net_fils + vat_fils),
  CONSTRAINT quotations_revision_ck CHECK ((revision = 1) = (revised_from_id IS NULL)),
  CONSTRAINT quotations_converted_ck CHECK ((status = 'converted') = (converted_document_id IS NOT NULL))
);
CREATE INDEX quotations_customer_ix ON sales.quotations (customer_id);

CREATE TABLE sales.quotation_lines (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quotation_id                bigint NOT NULL REFERENCES sales.quotations (id),
  line_no                     smallint NOT NULL CHECK (line_no > 0),
  item_id                     bigint NOT NULL REFERENCES md.items (id),
  description_ar              text NOT NULL CHECK (btrim(description_ar) <> '' AND length(description_ar) <= 500),
  description_en              text NOT NULL CHECK (btrim(description_en) <> '' AND length(description_en) <= 500),
  unit_id                     bigint NOT NULL REFERENCES md.units (id),
  business_line_id            bigint NOT NULL REFERENCES md.business_lines (id),
  quantity                    numeric(14,3) NOT NULL CHECK (quantity > 0),
  list_price_4dp              bigint NOT NULL CHECK (list_price_4dp >= 0),
  unit_price_4dp              bigint NOT NULL CHECK (unit_price_4dp >= 0),
  price_includes_vat          boolean NOT NULL,
  amount_before_discount_fils bigint NOT NULL,
  line_discount_bp            integer CHECK (line_discount_bp BETWEEN 0 AND 10000),
  line_discount_fils          bigint NOT NULL DEFAULT 0 CHECK (line_discount_fils >= 0),
  doc_discount_alloc_fils     bigint NOT NULL DEFAULT 0 CHECK (doc_discount_alloc_fils >= 0),
  discount_excl_vat_fils      bigint NOT NULL DEFAULT 0,
  net_fils                    bigint NOT NULL CHECK (net_fils >= 0),
  vat_fils                    bigint NOT NULL CHECK (vat_fils >= 0),
  gross_fils                  bigint NOT NULL,
  vat_category_id             bigint NOT NULL REFERENCES md.vat_categories (id),
  vat_rate_bp                 integer NOT NULL,
  is_optional                 boolean NOT NULL DEFAULT false,
  note                        text CHECK (length(note) <= 1000),
  CONSTRAINT quotation_lines_uq UNIQUE (quotation_id, line_no),
  CONSTRAINT quotation_lines_gross_ck CHECK (gross_fils = net_fils + vat_fils)
);

-- Quotation and document item lines: the list price, the VAT rate and every amount are set here.
CREATE FUNCTION sales.compute_item_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_level bigint;
  a record;
BEGIN
  IF TG_TABLE_NAME = 'document_lines' THEN
   IF NEW.line_kind <> 'item' THEN
    SELECT rate_bp, code INTO NEW.vat_rate_bp, NEW.vat_category_code
      FROM md.vat_categories WHERE id = NEW.vat_category_id;
    IF NEW.line_kind = 'advance' THEN
      -- The amount received includes VAT at the line's rate (decision 0013).
      NEW.price_includes_vat := true;
      NEW.list_price_4dp := NEW.unit_price_4dp;
      SELECT * INTO a FROM sales.line_amounts(NEW.quantity, NEW.unit_price_4dp, true, NEW.vat_rate_bp, 0, 0);
      NEW.amount_before_discount_fils := a.amount_before_fils;
      NEW.net_fils := a.net_fils;
      NEW.vat_fils := a.vat_fils;
      NEW.gross_fils := a.gross_fils;
      NEW.discount_excl_vat_fils := 0;
    END IF;
    RETURN NEW;
   END IF;
  END IF;

  IF TG_TABLE_NAME = 'quotation_lines' THEN
    SELECT price_level_id INTO v_level FROM sales.quotations WHERE id = NEW.quotation_id;
  ELSE
    SELECT coalesce(price_level_id, (SELECT id FROM md.price_levels WHERE is_default))
      INTO v_level FROM sales.documents WHERE id = NEW.document_id;
  END IF;
  SELECT coalesce(p.price_4dp, 0), coalesce(p.includes_vat, false)
    INTO NEW.list_price_4dp, NEW.price_includes_vat
    FROM md.items i LEFT JOIN md.item_prices p ON p.item_id = i.id AND p.price_level_id = v_level
   WHERE i.id = NEW.item_id;
  SELECT vat_category_id INTO NEW.vat_category_id FROM md.items WHERE id = NEW.item_id;
  SELECT rate_bp INTO NEW.vat_rate_bp FROM md.vat_categories WHERE id = NEW.vat_category_id;
  IF TG_TABLE_NAME = 'document_lines' THEN
    SELECT code INTO NEW.vat_category_code FROM md.vat_categories WHERE id = NEW.vat_category_id;
    SELECT item_type INTO NEW.item_type FROM md.items WHERE id = NEW.item_id;
  END IF;
  SELECT * INTO a FROM sales.line_amounts(NEW.quantity, NEW.unit_price_4dp, NEW.price_includes_vat,
                                          NEW.vat_rate_bp, NEW.line_discount_fils, NEW.doc_discount_alloc_fils);
  NEW.amount_before_discount_fils := a.amount_before_fils;
  NEW.net_fils := a.net_fils;
  NEW.vat_fils := a.vat_fils;
  NEW.gross_fils := a.gross_fils;
  NEW.discount_excl_vat_fils := a.discount_excl_vat_fils;
  RETURN NEW;
END $$;
CREATE TRIGGER b_compute_line BEFORE INSERT OR UPDATE ON sales.quotation_lines
  FOR EACH ROW EXECUTE FUNCTION sales.compute_item_line();
CREATE TRIGGER guard_draft_lines BEFORE INSERT OR UPDATE OR DELETE ON sales.quotation_lines
  FOR EACH ROW EXECUTE FUNCTION sys.guard_draft_lines('sales.quotations', 'quotation_id', 'status', 'draft');
SELECT audit.enable_for('sales.quotation_lines');
SELECT sys.forbid_delete('sales.quotation_lines', p_allow_delete => true);

/** Recomputes a quotation's totals from its lines (optional lines are not counted). */
CREATE FUNCTION sales.quotation_totals(p_id bigint, OUT discount_fils bigint, OUT net_fils bigint, OUT vat_fils bigint)
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(line_discount_fils + doc_discount_alloc_fils), 0)::bigint,
         coalesce(sum(net_fils), 0)::bigint, coalesce(sum(vat_fils), 0)::bigint
    FROM sales.quotation_lines WHERE quotation_id = p_id AND NOT is_optional
$$;

CREATE FUNCTION sales.quotation_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_number record;
  t record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'A quotation starts as a draft' USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
    END IF;
    NEW.series_id := sales.series_for('quotation', NULL);
    IF NEW.revised_from_id IS NULL THEN
      SELECT * INTO v_number FROM sys.next_number(NEW.series_id);
      NEW.seq_no := v_number.seq_no;
      NEW.doc_number := v_number.formatted;
      NEW.revision := 1;
    ELSE
      -- A revision keeps the number, one revision higher; the revised quotation is superseded.
      SELECT seq_no, doc_number, revision + 1 INTO NEW.seq_no, NEW.doc_number, NEW.revision
        FROM sales.quotations WHERE id = NEW.revised_from_id AND status = 'sent' FOR UPDATE;
      IF NEW.seq_no IS NULL THEN
        RAISE EXCEPTION 'Only a sent quotation gets a revision' USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
      END IF;
      UPDATE sales.quotations SET status = 'superseded' WHERE id = NEW.revised_from_id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status IN ('sent', 'cancelled'))
            OR (OLD.status = 'sent' AND NEW.status IN ('accepted', 'rejected', 'expired', 'superseded', 'cancelled'))
            OR (OLD.status = 'accepted' AND NEW.status IN ('converted', 'cancelled'))) THEN
      RAISE EXCEPTION 'A quotation cannot go from % to %', OLD.status, NEW.status
        USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
    END IF;
    IF NEW.status = 'sent' THEN
      IF NOT EXISTS (SELECT 1 FROM sales.quotation_lines WHERE quotation_id = NEW.id AND NOT is_optional) THEN
        RAISE EXCEPTION 'A quotation needs at least one line' USING ERRCODE = 'AP011', HINT = 'DOCUMENT_EMPTY';
      END IF;
      SELECT * INTO t FROM sales.quotation_totals(NEW.id);
      NEW.discount_total_fils := t.discount_fils;
      NEW.net_fils := t.net_fils;
      NEW.vat_fils := t.vat_fils;
      NEW.total_fils := t.net_fils + t.vat_fils;
      NEW.sent_at := now();
    ELSIF NEW.status <> 'cancelled' OR OLD.status <> 'draft' THEN
      NEW.decided_at := now();
    END IF;
  ELSIF OLD.status = 'draft' THEN
    -- While a draft, the totals always follow the lines.
    SELECT * INTO t FROM sales.quotation_totals(NEW.id);
    NEW.discount_total_fils := t.discount_fils;
    NEW.net_fils := t.net_fils;
    NEW.vat_fils := t.vat_fils;
    NEW.total_fils := t.net_fils + t.vat_fils;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_quotation_rules BEFORE INSERT OR UPDATE ON sales.quotations
  FOR EACH ROW EXECUTE FUNCTION sales.quotation_rules();
SELECT sys.add_touch('sales.quotations');
SELECT audit.enable_for('sales.quotations');
SELECT sys.forbid_delete('sales.quotations');
SELECT sys.add_immutable_guard('sales.quotations', 'status', 'draft', 'status,decided_at,converted_document_id');

-- ---------------------------------------------------------------------------------------------
-- Tax documents and their lines (immutable after issue)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sales.documents (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid                   uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  doc_type               text NOT NULL CHECK (doc_type IN ('invoice', 'advance_invoice', 'credit_note', 'debit_note')),
  invoice_format         text NOT NULL DEFAULT 'simplified' CHECK (invoice_format IN ('full', 'simplified')),
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'discarded')),
  series_id              bigint NOT NULL REFERENCES sys.document_series (id),
  seq_no                 bigint,
  doc_number             text,
  channel                text NOT NULL CHECK (channel IN ('pos', 'office')),
  branch_id              bigint NOT NULL REFERENCES sys.branches (id),
  business_line_id       bigint NOT NULL REFERENCES md.business_lines (id),
  warehouse_id           bigint NOT NULL REFERENCES md.warehouses (id),
  device_id              bigint NOT NULL REFERENCES auth.devices (id),
  register_id            bigint REFERENCES cash.registers (id),
  shift_id               bigint REFERENCES cash.shifts (id),
  pos_cart_id            uuid,
  customer_id            bigint NOT NULL REFERENCES md.customers (id),
  bill_to_name           text NOT NULL CHECK (btrim(bill_to_name) <> ''),
  bill_to_name_alt       text,
  bill_to_trn            char(15),
  bill_to_address        text,
  bill_to_phone          text,
  seller_snapshot        jsonb,
  issue_date             date,
  supply_date            date,
  issued_at              timestamptz,
  due_date               date,
  currency               char(3) NOT NULL DEFAULT 'AED' CHECK (currency = 'AED'),
  price_level_id         bigint REFERENCES md.price_levels (id),
  salesperson_id         bigint REFERENCES auth.users (id),
  quotation_id           bigint REFERENCES sales.quotations (id),
  original_document_id   bigint REFERENCES sales.documents (id),
  reason_code_id         bigint REFERENCES sys.reason_codes (id),
  reason_text            text CHECK (reason_text IS NULL OR length(btrim(reason_text)) BETWEEN 3 AND 1000),
  approval_id            bigint REFERENCES auth.approvals (id),
  credit_approval_id     bigint REFERENCES auth.approvals (id),
  doc_discount_fils      bigint NOT NULL DEFAULT 0 CHECK (doc_discount_fils >= 0),
  discount_total_fils    bigint NOT NULL DEFAULT 0 CHECK (discount_total_fils >= 0),
  net_fils               bigint NOT NULL DEFAULT 0 CHECK (net_fils >= 0),
  vat_fils               bigint NOT NULL DEFAULT 0 CHECK (vat_fils >= 0),
  total_fils             bigint NOT NULL DEFAULT 0,
  cost_fils              bigint NOT NULL DEFAULT 0 CHECK (cost_fils >= 0),
  settled_fils           bigint NOT NULL DEFAULT 0 CHECK (settled_fils >= 0),
  settlement_status      text NOT NULL DEFAULT 'open' CHECK (settlement_status IN ('open', 'partial', 'settled')),
  advance_used_net_fils  bigint NOT NULL DEFAULT 0 CHECK (advance_used_net_fils >= 0),
  advance_used_vat_fils  bigint NOT NULL DEFAULT 0 CHECK (advance_used_vat_fils >= 0),
  content_hash           bytea,
  print_count            integer NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  notes                  text CHECK (length(notes) <= 2000),
  internal_note          text CHECK (length(internal_note) <= 2000),
  issued_by              bigint REFERENCES auth.users (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             bigint NOT NULL REFERENCES auth.users (id),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             bigint NOT NULL REFERENCES auth.users (id),
  row_version            integer NOT NULL DEFAULT 1,
  CONSTRAINT documents_number_uq UNIQUE (series_id, seq_no),
  CONSTRAINT documents_total_ck CHECK (total_fils = net_fils + vat_fils),
  CONSTRAINT documents_settled_ck CHECK (settled_fils <= total_fils),
  CONSTRAINT documents_number_ck CHECK (
    (status = 'issued') = (seq_no IS NOT NULL) AND (seq_no IS NULL) = (doc_number IS NULL)),
  CONSTRAINT documents_issued_ck CHECK (status <> 'issued' OR num_nulls(issue_date, issued_at, issued_by,
    content_hash, seller_snapshot) = 0),
  -- Decision 0010: a full tax invoice exactly when the customer's TRN is on it.
  CONSTRAINT documents_format_ck CHECK (status <> 'issued' OR (invoice_format = 'full') = (bill_to_trn IS NOT NULL)),
  CONSTRAINT documents_advance_channel_ck CHECK (doc_type <> 'advance_invoice' OR channel = 'office'),
  CONSTRAINT documents_pos_shift_ck CHECK (channel <> 'pos' OR shift_id IS NOT NULL),
  CONSTRAINT documents_note_ck CHECK ((doc_type IN ('credit_note', 'debit_note')) = (original_document_id IS NOT NULL)),
  CONSTRAINT documents_note_reason_ck CHECK (doc_type NOT IN ('credit_note', 'debit_note')
    OR (reason_code_id IS NOT NULL AND reason_text IS NOT NULL)),
  CONSTRAINT documents_advance_used_ck CHECK (
    (doc_type = 'advance_invoice' OR (advance_used_net_fils = 0 AND advance_used_vat_fils = 0))
    AND advance_used_net_fils <= net_fils AND advance_used_vat_fils <= vat_fils),
  CONSTRAINT documents_due_ck CHECK (due_date IS NULL OR issue_date IS NULL OR due_date >= issue_date)
);
CREATE INDEX documents_customer_ix ON sales.documents (customer_id, status);
CREATE INDEX documents_issue_date_ix ON sales.documents (issue_date) WHERE status = 'issued';
CREATE INDEX documents_quotation_ix ON sales.documents (quotation_id) WHERE quotation_id IS NOT NULL;

ALTER TABLE sales.quotations
  ADD CONSTRAINT quotations_converted_fk FOREIGN KEY (converted_document_id) REFERENCES sales.documents (id);

CREATE TABLE sales.document_lines (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id                 bigint NOT NULL REFERENCES sales.documents (id),
  line_no                     smallint NOT NULL CHECK (line_no > 0),
  line_kind                   text NOT NULL DEFAULT 'item' CHECK (line_kind IN ('item', 'advance', 'advance_deduction')),
  item_id                     bigint REFERENCES md.items (id),
  item_type                   text,
  description_ar              text NOT NULL CHECK (btrim(description_ar) <> '' AND length(description_ar) <= 500),
  description_en              text NOT NULL CHECK (btrim(description_en) <> '' AND length(description_en) <= 500),
  unit_id                     bigint REFERENCES md.units (id),
  business_line_id            bigint NOT NULL REFERENCES md.business_lines (id),
  quantity                    numeric(14,3) NOT NULL CHECK (quantity > 0),
  list_price_4dp              bigint NOT NULL DEFAULT 0,
  price_includes_vat          boolean NOT NULL DEFAULT false,
  unit_price_4dp              bigint NOT NULL,
  price_override_approval_id  bigint REFERENCES auth.approvals (id),
  amount_before_discount_fils bigint NOT NULL DEFAULT 0,
  line_discount_bp            integer CHECK (line_discount_bp BETWEEN 0 AND 10000),
  line_discount_fils          bigint NOT NULL DEFAULT 0 CHECK (line_discount_fils >= 0),
  doc_discount_alloc_fils     bigint NOT NULL DEFAULT 0 CHECK (doc_discount_alloc_fils >= 0),
  discount_excl_vat_fils      bigint NOT NULL DEFAULT 0 CHECK (discount_excl_vat_fils >= 0),
  net_fils                    bigint NOT NULL,
  vat_category_id             bigint NOT NULL REFERENCES md.vat_categories (id),
  vat_category_code           text NOT NULL DEFAULT '',
  vat_rate_bp                 integer NOT NULL DEFAULT 0,
  vat_fils                    bigint NOT NULL,
  gross_fils                  bigint NOT NULL,
  cost_fils                   bigint NOT NULL DEFAULT 0 CHECK (cost_fils >= 0),
  advance_document_id         bigint REFERENCES sales.documents (id),
  original_line_id            bigint REFERENCES sales.document_lines (id),
  return_stock_status         text CHECK (return_stock_status IN ('available', 'defective')),
  technician_id               bigint REFERENCES md.technicians (id),
  note                        text CHECK (length(note) <= 1000),
  CONSTRAINT document_lines_uq UNIQUE (document_id, line_no),
  CONSTRAINT document_lines_gross_ck CHECK (gross_fils = net_fils + vat_fils),
  CONSTRAINT document_lines_item_ck CHECK ((line_kind = 'item') = (item_id IS NOT NULL)),
  CONSTRAINT document_lines_one_ck CHECK (line_kind = 'item' OR quantity = 1),
  CONSTRAINT document_lines_deduction_ck CHECK ((line_kind = 'advance_deduction') = (advance_document_id IS NOT NULL)),
  CONSTRAINT document_lines_signs_ck CHECK (CASE WHEN line_kind = 'advance_deduction'
    THEN net_fils <= 0 AND vat_fils <= 0 AND line_discount_fils = 0 AND doc_discount_alloc_fils = 0
    ELSE unit_price_4dp >= 0 AND net_fils >= 0 AND vat_fils >= 0 END)
);
CREATE INDEX document_lines_original_ix ON sales.document_lines (original_line_id) WHERE original_line_id IS NOT NULL;
CREATE INDEX document_lines_advance_ix ON sales.document_lines (advance_document_id) WHERE advance_document_id IS NOT NULL;

CREATE TRIGGER b_compute_line BEFORE INSERT OR UPDATE ON sales.document_lines
  FOR EACH ROW EXECUTE FUNCTION sales.compute_item_line();

-- Which line kinds a document may hold, and the credit note's link to the original line.
CREATE FUNCTION sales.document_line_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d record;
  o record;
BEGIN
  SELECT doc_type, customer_id, original_document_id INTO d FROM sales.documents WHERE id = NEW.document_id;
  IF (NEW.line_kind = 'advance' AND d.doc_type <> 'advance_invoice')
     OR (NEW.line_kind = 'advance_deduction' AND d.doc_type <> 'invoice')
     OR (d.doc_type = 'advance_invoice' AND NEW.line_kind <> 'advance') THEN
    RAISE EXCEPTION 'This kind of line does not belong on this document' USING ERRCODE = 'AP011', HINT = 'LINE_KIND';
  END IF;
  IF NEW.original_line_id IS NOT NULL THEN
    SELECT l.document_id, l.item_id, l.line_kind INTO o FROM sales.document_lines l WHERE l.id = NEW.original_line_id;
    IF d.doc_type NOT IN ('credit_note', 'debit_note') OR o.document_id IS DISTINCT FROM d.original_document_id
       OR o.item_id IS DISTINCT FROM NEW.item_id THEN
      RAISE EXCEPTION 'A note line refers to a line of its original document' USING ERRCODE = 'AP011', HINT = 'NOTE_LINE';
    END IF;
  END IF;
  IF NEW.return_stock_status IS NOT NULL AND (d.doc_type <> 'credit_note' OR NEW.original_line_id IS NULL) THEN
    RAISE EXCEPTION 'Only a credit note line returns goods' USING ERRCODE = 'AP011', HINT = 'NOTE_LINE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c_document_line_rules BEFORE INSERT OR UPDATE ON sales.document_lines
  FOR EACH ROW EXECUTE FUNCTION sales.document_line_rules();
CREATE TRIGGER guard_draft_lines BEFORE INSERT OR UPDATE OR DELETE ON sales.document_lines
  FOR EACH ROW EXECUTE FUNCTION sys.guard_draft_lines('sales.documents', 'document_id', 'status', 'draft');
SELECT audit.enable_for('sales.document_lines');
SELECT sys.forbid_delete('sales.document_lines', p_allow_delete => true);

-- A sale or return movement belongs to a stock line of a document being issued (draft), once.
CREATE FUNCTION sales.sale_movement_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l record;
  v_fits boolean;
BEGIN
  IF NEW.sales_document_line_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT dl.item_id, dl.item_type, dl.quantity, dl.return_stock_status, d.status, d.doc_type, d.warehouse_id,
         -- the quantity this movement must move: the line's, or for a kit its component's share
         CASE WHEN dl.item_type = 'bundle'
              THEN dl.quantity * (SELECT c.quantity FROM md.bundle_components c
                                   WHERE c.bundle_item_id = dl.item_id AND c.component_item_id = NEW.item_id)
              WHEN dl.item_id = NEW.item_id THEN dl.quantity END AS qty
    INTO l
    FROM sales.document_lines dl JOIN sales.documents d ON d.id = dl.document_id
   WHERE dl.id = NEW.sales_document_line_id
     FOR SHARE OF d;
  v_fits := CASE NEW.movement_type
              WHEN 'sale' THEN l.doc_type = 'invoice' AND NEW.quantity = -l.qty AND NEW.stock_status = 'available'
              WHEN 'sale_return' THEN l.doc_type = 'credit_note' AND NEW.quantity = l.qty
                                      AND NEW.stock_status = l.return_stock_status
              ELSE false END;
  IF l.status IS DISTINCT FROM 'draft' OR l.qty IS NULL OR l.warehouse_id <> NEW.warehouse_id
     OR l.item_type NOT IN ('stock', 'bundle') OR v_fits IS NOT TRUE
     OR EXISTS (SELECT 1 FROM inv.movements
                 WHERE sales_document_line_id = NEW.sales_document_line_id AND item_id = NEW.item_id) THEN
    RAISE EXCEPTION 'This movement does not fit the document line' USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_sale_movement_rules BEFORE INSERT ON inv.movements
  FOR EACH ROW EXECUTE FUNCTION sales.sale_movement_rules();


/** The best discount limit of a user: their own, else the most generous of their roles. */
CREATE FUNCTION sales.discount_limit(p_user_id bigint, OUT max_bp integer, OUT max_fils bigint)
LANGUAGE sql STABLE AS $$
  SELECT coalesce(u.max_discount_bp, (SELECT max(r.max_discount_bp) FROM auth.user_roles ur
                                        JOIN auth.roles r ON r.id = ur.role_id
                                       WHERE ur.user_id = u.id AND r.is_active), 0),
         coalesce(u.max_discount_fils, (SELECT max(r.max_discount_fils) FROM auth.user_roles ur
                                          JOIN auth.roles r ON r.id = ur.role_id
                                         WHERE ur.user_id = u.id AND r.is_active), 0)
    FROM auth.users u WHERE u.id = p_user_id
$$;

CREATE FUNCTION sales.document_rules() RETURNS trigger
-- Runs with the owner's rights: it maintains amounts the API may never set itself.
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c record;
  v_user bigint;
  v_number record;
  v_limit record;
  v_before bigint;
  l record;
  a record;
  v_moved bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'A document starts as a draft' USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
    END IF;
    -- POS- for the POS, INV- for the office; notes have their own series (0011).
    NEW.series_id := sales.series_for(NEW.doc_type, NEW.channel);
    NEW.device_id := coalesce(sys.ctx_device_id(), NEW.device_id);
    IF NEW.channel = 'pos' THEN
      NEW.register_id := cash.assert_shift_owner(NEW.shift_id);
    END IF;
    IF NEW.doc_type = 'advance_invoice' THEN
      NEW.price_level_id := NULL;
    ELSE
      NEW.price_level_id := coalesce(NEW.price_level_id, (SELECT id FROM md.price_levels WHERE is_default));
    END IF;
    IF NEW.original_document_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM sales.documents
          WHERE id = NEW.original_document_id AND status = 'issued' AND customer_id = NEW.customer_id
            AND doc_type IN ('invoice', 'advance_invoice')) THEN
      RAISE EXCEPTION 'A note refers to an issued invoice of the same customer'
        USING ERRCODE = 'AP011', HINT = 'NOTE_ORIGINAL';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'draft' THEN
    -- While a draft, the totals always follow the lines.
    SELECT coalesce(sum(line_discount_fils + doc_discount_alloc_fils), 0), coalesce(sum(net_fils), 0),
           coalesce(sum(vat_fils), 0)
      INTO NEW.discount_total_fils, NEW.net_fils, NEW.vat_fils
      FROM sales.document_lines WHERE document_id = NEW.id;
    NEW.total_fils := NEW.net_fils + NEW.vat_fils;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (OLD.status = 'draft' AND NEW.status IN ('issued', 'discarded')) THEN
      RAISE EXCEPTION 'A document goes from draft to issued or discarded only'
        USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'issued' THEN
    v_user := sys.require_user();
    NEW.issue_date := coalesce(NEW.issue_date, sys.business_date());
    PERFORM gl.assert_period_open(NEW.issue_date);
    IF NOT EXISTS (SELECT 1 FROM sales.document_lines WHERE document_id = NEW.id) THEN
      RAISE EXCEPTION 'A document needs at least one line' USING ERRCODE = 'AP011', HINT = 'DOCUMENT_EMPTY';
    END IF;

    -- The totals, discount and cost are the lines' (never the request's).
    SELECT coalesce(sum(line_discount_fils + doc_discount_alloc_fils), 0), coalesce(sum(net_fils), 0),
           coalesce(sum(vat_fils), 0), coalesce(sum(cost_fils), 0),
           coalesce(sum(amount_before_discount_fils) FILTER (WHERE line_kind = 'item'), 0)
      INTO NEW.discount_total_fils, NEW.net_fils, NEW.vat_fils, NEW.cost_fils, v_before
      FROM sales.document_lines WHERE document_id = NEW.id;
    NEW.total_fils := NEW.net_fils + NEW.vat_fils;
    IF NEW.total_fils <= 0 AND NEW.doc_type <> 'invoice' THEN
      RAISE EXCEPTION 'A document needs an amount above zero' USING ERRCODE = 'AP011', HINT = 'DOCUMENT_EMPTY';
    END IF;

    -- Decision 0010: the format and the TRN come from the customer at issue.
    SELECT * INTO c FROM md.customers WHERE id = NEW.customer_id;
    IF NOT c.is_active THEN
      RAISE EXCEPTION 'This customer is deactivated' USING ERRCODE = 'AP011', HINT = 'CUSTOMER_INACTIVE';
    END IF;
    NEW.invoice_format := CASE WHEN c.is_vat_registered THEN 'full' ELSE 'simplified' END;
    NEW.bill_to_trn := CASE WHEN c.is_vat_registered THEN c.trn END;
    NEW.seller_snapshot := (SELECT to_jsonb(p) - ARRAY['logo', 'created_at', 'created_by', 'updated_at',
                                                       'updated_by', 'row_version']
                              FROM sys.company_profile p WHERE id = 1);
    IF NEW.seller_snapshot IS NULL THEN
      RAISE EXCEPTION 'The company details must be filled in first' USING ERRCODE = 'AP011', HINT = 'COMPANY_MISSING';
    END IF;

    -- An approval attached to the document must be for what it approves.
    IF NEW.approval_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.approvals WHERE id = NEW.approval_id
         AND permission_code IN ('sales.discount_over_limit', 'credit_notes.issue', 'sales.price_override')) THEN
      RAISE EXCEPTION 'This approval is for something else' USING ERRCODE = 'AP012', HINT = 'APPROVAL_INVALID';
    END IF;
    IF NEW.credit_approval_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.approvals
         WHERE id = NEW.credit_approval_id AND permission_code = 'sales.credit_over_limit') THEN
      RAISE EXCEPTION 'This approval is for something else' USING ERRCODE = 'AP012', HINT = 'APPROVAL_INVALID';
    END IF;

    -- Price overrides need the permission or an approval; discounts above the limit likewise (0012).
    IF EXISTS (SELECT 1 FROM sales.document_lines
                WHERE document_id = NEW.id AND line_kind = 'item' AND unit_price_4dp <> list_price_4dp
                  AND price_override_approval_id IS NULL)
       AND NEW.doc_type IN ('invoice', 'debit_note')
       AND NOT auth.user_has_permission(v_user, 'sales.price_override') THEN
      RAISE EXCEPTION 'A changed price needs approval' USING ERRCODE = 'AP012', HINT = 'PRICE_OVERRIDE';
    END IF;
    IF NEW.discount_total_fils > 0 AND NEW.doc_type = 'invoice' AND NEW.approval_id IS NULL
       AND NOT auth.user_has_permission(v_user, 'sales.discount_over_limit') THEN
      SELECT * INTO v_limit FROM sales.discount_limit(v_user);
      IF NEW.discount_total_fils > v_limit.max_fils
         OR NEW.discount_total_fils * 10000 > v_limit.max_bp::bigint * v_before THEN
        RAISE EXCEPTION 'This discount is above your limit' USING ERRCODE = 'AP012', HINT = 'DISCOUNT_OVER_LIMIT';
      END IF;
    END IF;

    -- Stock lines: exactly their movement, and the cost it left (or came back) with.
    FOR l IN SELECT dl.id, dl.item_id, dl.item_type, dl.cost_fils, dl.return_stock_status
               FROM sales.document_lines dl WHERE dl.document_id = NEW.id AND dl.line_kind = 'item' LOOP
      SELECT coalesce(sum(abs(m.value_fils)), 0) INTO v_moved
        FROM inv.movements m WHERE m.sales_document_line_id = l.id;
      IF (NEW.doc_type = 'invoice' OR (NEW.doc_type = 'credit_note' AND l.return_stock_status IS NOT NULL))
         AND EXISTS (
           SELECT 1
             FROM (SELECT l.item_id AS item_id WHERE l.item_type = 'stock'
                   UNION ALL
                   SELECT bc.component_item_id FROM md.bundle_components bc JOIN md.items ci ON ci.id = bc.component_item_id
                    WHERE l.item_type = 'bundle' AND bc.bundle_item_id = l.item_id AND ci.item_type = 'stock') need
            WHERE NOT EXISTS (SELECT 1 FROM inv.movements m
                               WHERE m.sales_document_line_id = l.id AND m.item_id = need.item_id)) THEN
        RAISE EXCEPTION 'A stock line needs its stock movement' USING ERRCODE = 'AP011', HINT = 'STOCK_LINE';
      END IF;
      IF l.cost_fils <> v_moved THEN
        RAISE EXCEPTION 'A line''s cost must be its movement''s value' USING ERRCODE = 'AP011', HINT = 'STOCK_LINE';
      END IF;
    END LOOP;

    -- Advance deductions (0013): an issued payment invoice of the same customer, never beyond what remains.
    FOR l IN SELECT dl.advance_document_id, sum(-dl.net_fils) AS net, sum(-dl.vat_fils) AS vat
               FROM sales.document_lines dl
              WHERE dl.document_id = NEW.id AND dl.line_kind = 'advance_deduction'
              GROUP BY dl.advance_document_id LOOP
      SELECT id, customer_id, status, doc_type, net_fils - advance_used_net_fils AS net_left,
             vat_fils - advance_used_vat_fils AS vat_left
        INTO a FROM sales.documents WHERE id = l.advance_document_id FOR UPDATE;
      IF a.doc_type IS DISTINCT FROM 'advance_invoice' OR a.status <> 'issued' OR a.customer_id <> NEW.customer_id THEN
        RAISE EXCEPTION 'Only an issued payment invoice of the same customer can be deducted'
          USING ERRCODE = 'AP011', HINT = 'ADVANCE_DEDUCTION';
      END IF;
      IF l.net > a.net_left OR l.vat > a.vat_left THEN
        RAISE EXCEPTION 'The deduction is more than what remains of the payment'
          USING ERRCODE = 'AP011', HINT = 'ADVANCE_DEDUCTION';
      END IF;
      UPDATE sales.documents SET advance_used_net_fils = advance_used_net_fils + l.net,
                                 advance_used_vat_fils = advance_used_vat_fils + l.vat
       WHERE id = a.id;
    END LOOP;

    -- Notes: never more than the original; a credit note on a payment invoice reverses the advance.
    IF NEW.doc_type IN ('credit_note', 'debit_note') THEN
      IF NEW.doc_type = 'credit_note' AND EXISTS (
           SELECT 1 FROM sales.document_lines n JOIN sales.document_lines o ON o.id = n.original_line_id
            WHERE n.document_id = NEW.id
              AND n.quantity + coalesce((SELECT sum(x.quantity) FROM sales.document_lines x
                                           JOIN sales.documents xd ON xd.id = x.document_id
                                          WHERE x.original_line_id = o.id AND xd.status = 'issued'
                                            AND xd.doc_type = 'credit_note'), 0) > o.quantity) THEN
        RAISE EXCEPTION 'More is credited than the original line' USING ERRCODE = 'AP011', HINT = 'NOTE_EXCEEDS';
      END IF;
      IF NEW.doc_type = 'credit_note' THEN
        SELECT * INTO a FROM sales.documents WHERE id = NEW.original_document_id FOR UPDATE;
        IF NEW.total_fils + coalesce((SELECT sum(total_fils) FROM sales.documents
                                       WHERE original_document_id = a.id AND doc_type = 'credit_note'
                                         AND status = 'issued'), 0) > a.total_fils THEN
          RAISE EXCEPTION 'More is credited than the original document' USING ERRCODE = 'AP011', HINT = 'NOTE_EXCEEDS';
        END IF;
        IF a.doc_type = 'advance_invoice' THEN
          IF NEW.net_fils > a.net_fils - a.advance_used_net_fils OR NEW.vat_fils > a.vat_fils - a.advance_used_vat_fils THEN
            RAISE EXCEPTION 'More is credited than what remains of the payment'
              USING ERRCODE = 'AP011', HINT = 'ADVANCE_DEDUCTION';
          END IF;
          UPDATE sales.documents SET advance_used_net_fils = advance_used_net_fils + NEW.net_fils,
                                     advance_used_vat_fils = advance_used_vat_fils + NEW.vat_fils
           WHERE id = a.id;
        END IF;
      END IF;
    END IF;

    SELECT * INTO v_number FROM sys.next_number(NEW.series_id);
    NEW.seq_no := v_number.seq_no;
    NEW.doc_number := v_number.formatted;
    NEW.issued_at := now();
    NEW.issued_by := v_user;
    NEW.supply_date := coalesce(NEW.supply_date, NEW.issue_date);
    IF NEW.due_date IS NULL AND NEW.doc_type IN ('invoice', 'debit_note') THEN
      NEW.due_date := NEW.issue_date + c.payment_terms_days;
    END IF;
  END IF;

  -- The settlement state follows the settled amount.
  NEW.settlement_status := CASE WHEN NEW.settled_fils = 0 THEN 'open'
                                WHEN NEW.settled_fils >= NEW.total_fils THEN 'settled' ELSE 'partial' END;
  RETURN NEW;
END $$;
CREATE TRIGGER b_document_rules BEFORE INSERT OR UPDATE ON sales.documents
  FOR EACH ROW EXECUTE FUNCTION sales.document_rules();
SELECT sys.add_touch('sales.documents');
SELECT audit.enable_for('sales.documents');
SELECT sys.forbid_delete('sales.documents');
SELECT sys.add_immutable_guard('sales.documents', 'status', 'draft',
  'settled_fils,settlement_status,advance_used_net_fils,advance_used_vat_fils,print_count');

-- At commit: an issued document has its journal entry, and an unpaid one fits the customer's credit (0046).
CREATE FUNCTION sales.document_commit_checks() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d record;
  c record;
  v_limit bigint;
BEGIN
  SELECT * INTO d FROM sales.documents WHERE id = NEW.id;
  IF d.status <> 'issued' THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gl.journal_entries WHERE source_type = 'sales_document' AND sales_document_id = d.id) THEN
    RAISE EXCEPTION 'An issued document needs its journal entry' USING ERRCODE = 'AP011', HINT = 'JOURNAL_MISSING';
  END IF;
  IF d.doc_type IN ('invoice', 'debit_note') AND d.settled_fils < d.total_fils AND d.credit_approval_id IS NULL THEN
    SELECT credit_mode, credit_limit_fils INTO c FROM md.customers WHERE id = d.customer_id;
    v_limit := CASE WHEN c.credit_mode = 'credit' THEN c.credit_limit_fils ELSE 0 END;
    IF sales.customer_balance(d.customer_id) > v_limit THEN
      RAISE EXCEPTION 'This unpaid amount is above the customer''s credit' USING ERRCODE = 'AP012', HINT = 'CREDIT_LIMIT';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER z_document_commit AFTER UPDATE OF status ON sales.documents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'issued' AND OLD.status = 'draft')
  EXECUTE FUNCTION sales.document_commit_checks();

-- ---------------------------------------------------------------------------------------------
-- Opening balances (decision 0051): once per customer, owner only
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sales.opening_balances (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id      bigint NOT NULL UNIQUE REFERENCES md.customers (id),
  balance_date     date NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('receivable', 'payable')),
  amount_fils      bigint NOT NULL CHECK (amount_fils > 0),
  reference        text CHECK (length(reference) <= 100),
  due_date         date,
  settled_fils     bigint NOT NULL DEFAULT 0 CHECK (settled_fils >= 0),
  import_batch_id  bigint REFERENCES sys.import_batches (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       bigint NOT NULL REFERENCES auth.users (id),
  CONSTRAINT opening_balances_settled_ck CHECK (settled_fils <= amount_fils)
);
CREATE FUNCTION sales.opening_balance_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT auth.user_has_permission(sys.require_user(), 'customers.opening') THEN
      RAISE EXCEPTION 'Only the owner enters customer opening balances'
        USING ERRCODE = 'AP012', HINT = 'OPENING_OWNER_ONLY';
    END IF;
    PERFORM gl.assert_period_open(NEW.balance_date);
    NEW.settled_fils := 0;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_opening_balance_rules BEFORE INSERT ON sales.opening_balances
  FOR EACH ROW EXECUTE FUNCTION sales.opening_balance_rules();
SELECT sys.add_stamp('sales.opening_balances');
SELECT audit.enable_for('sales.opening_balances');
SELECT sys.forbid_delete('sales.opening_balances');
SELECT sys.add_immutable_guard('sales.opening_balances', '', '', 'settled_fils');

/** What a customer owes (positive) or is owed (negative): open documents and opening balances. */
CREATE FUNCTION sales.customer_balance(p_customer_id bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT (coalesce((SELECT sum(CASE WHEN doc_type = 'credit_note' THEN -(total_fils - settled_fils)
                                    ELSE total_fils - settled_fils END)
                      FROM sales.documents WHERE customer_id = p_customer_id AND status = 'issued'), 0)
        + coalesce((SELECT sum(CASE WHEN direction = 'receivable' THEN amount_fils - settled_fils
                                    ELSE -(amount_fils - settled_fils) END)
                      FROM sales.opening_balances WHERE customer_id = p_customer_id), 0))::bigint
$$;

CREATE FUNCTION sales.opening_commit_checks() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gl.journal_entries WHERE source_type = 'opening_balance' AND opening_balance_id = NEW.id) THEN
    RAISE EXCEPTION 'An opening balance needs its journal entry' USING ERRCODE = 'AP011', HINT = 'JOURNAL_MISSING';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER z_opening_commit AFTER INSERT ON sales.opening_balances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sales.opening_commit_checks();

-- ---------------------------------------------------------------------------------------------
-- Payments (RCT- receipts, RFD- refunds, RVS- reversals): append-only
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sales.payments (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid               uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  payment_kind       text NOT NULL CHECK (payment_kind IN ('receipt', 'refund', 'reversal')),
  direction          text NOT NULL CHECK (direction IN ('in', 'out')),
  status             text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  reversal_of_id     bigint UNIQUE REFERENCES sales.payments (id),
  series_id          bigint NOT NULL REFERENCES sys.document_series (id),
  seq_no             bigint NOT NULL,
  doc_number         text NOT NULL,
  customer_id        bigint NOT NULL REFERENCES md.customers (id),
  payment_method_id  bigint NOT NULL REFERENCES md.payment_methods (id),
  method_kind        text NOT NULL,
  amount_fils        bigint NOT NULL CHECK (amount_fils > 0),
  tendered_fils      bigint CHECK (tendered_fils > 0),
  change_fils        bigint CHECK (change_fils >= 0),
  reference          text CHECK (length(reference) <= 100),
  cheque_date        date,
  cheque_bank        text CHECK (length(cheque_bank) <= 100),
  payment_date       date NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  channel            text NOT NULL CHECK (channel IN ('pos', 'office')),
  device_id          bigint NOT NULL REFERENCES auth.devices (id),
  register_id        bigint REFERENCES cash.registers (id),
  shift_id           bigint REFERENCES cash.shifts (id),
  allocated_fils     bigint NOT NULL DEFAULT 0 CHECK (allocated_fils >= 0),
  reason_code_id     bigint REFERENCES sys.reason_codes (id),
  approval_id        bigint REFERENCES auth.approvals (id),
  quotation_id       bigint REFERENCES sales.quotations (id),
  notes              text CHECK (length(notes) <= 1000),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         bigint NOT NULL REFERENCES auth.users (id),
  CONSTRAINT payments_number_uq UNIQUE (series_id, seq_no),
  CONSTRAINT payments_reversal_ck CHECK ((payment_kind = 'reversal') = (reversal_of_id IS NOT NULL)),
  CONSTRAINT payments_allocated_ck CHECK (allocated_fils <= amount_fils),
  CONSTRAINT payments_change_ck CHECK ((tendered_fils IS NULL) = (change_fils IS NULL)
    AND (tendered_fils IS NULL OR tendered_fils - change_fils = amount_fils)),
  CONSTRAINT payments_pos_ck CHECK (channel <> 'pos' OR method_kind <> 'cash' OR shift_id IS NOT NULL),
  CONSTRAINT payments_cheque_ck CHECK (method_kind <> 'cheque' OR reference IS NOT NULL),
  -- Never a full card number: at most the last 4 digits and an approval code.
  CONSTRAINT payments_card_ck CHECK (reference IS NULL OR reference !~ '[0-9]{12,}')
);
CREATE INDEX payments_customer_ix ON sales.payments (customer_id);
CREATE INDEX payments_date_ix ON sales.payments (payment_date);

CREATE FUNCTION sales.payment_rules() RETURNS trigger
-- Runs with the owner's rights: it maintains amounts the API may never set itself.
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m record;
  o record;
  v_number record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'posted' THEN
      RAISE EXCEPTION 'A payment is recorded as posted' USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
    END IF;
    PERFORM gl.assert_period_open(NEW.payment_date);
    SELECT kind, is_active, in_office, in_pos INTO m FROM md.payment_methods WHERE id = NEW.payment_method_id;
    IF NOT m.is_active OR (NEW.channel = 'office' AND NOT m.in_office) OR (NEW.channel = 'pos' AND NOT m.in_pos) THEN
      RAISE EXCEPTION 'This payment method cannot be used here' USING ERRCODE = 'AP011', HINT = 'PAYMENT_METHOD';
    END IF;
    NEW.method_kind := m.kind;
    NEW.device_id := coalesce(sys.ctx_device_id(), NEW.device_id);
    NEW.received_at := now();
    NEW.allocated_fils := 0;
    IF NEW.shift_id IS NOT NULL THEN
      NEW.register_id := cash.assert_shift_owner(NEW.shift_id);
    END IF;
    IF NEW.payment_kind = 'reversal' THEN
      -- A reversal undoes one posted payment of the same customer, for the same amount.
      SELECT * INTO o FROM sales.payments WHERE id = NEW.reversal_of_id FOR UPDATE;
      IF o.status IS DISTINCT FROM 'posted' OR o.payment_kind = 'reversal' OR o.customer_id <> NEW.customer_id
         OR o.amount_fils <> NEW.amount_fils OR o.payment_method_id <> NEW.payment_method_id THEN
        RAISE EXCEPTION 'Only a posted payment can be reversed, once, for its amount'
          USING ERRCODE = 'AP011', HINT = 'PAYMENT_REVERSAL';
      END IF;
      IF NEW.reason_code_id IS NULL THEN
        RAISE EXCEPTION 'A reversal needs a reason' USING ERRCODE = 'AP011', HINT = 'REASON_REQUIRED';
      END IF;
      NEW.direction := CASE o.direction WHEN 'in' THEN 'out' ELSE 'in' END;
      UPDATE sales.payments SET status = 'reversed' WHERE id = o.id;
    ELSE
      NEW.direction := CASE NEW.payment_kind WHEN 'receipt' THEN 'in' ELSE 'out' END;
    END IF;
    NEW.series_id := sales.series_for(CASE NEW.payment_kind WHEN 'receipt' THEN 'receipt'
                                           WHEN 'refund' THEN 'refund' ELSE 'payment_reversal' END, NULL);
    SELECT * INTO v_number FROM sys.next_number(NEW.series_id);
    NEW.seq_no := v_number.seq_no;
    NEW.doc_number := v_number.formatted;
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'posted' AND NEW.status = 'reversed') THEN
    RAISE EXCEPTION 'A reversed payment stays reversed' USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_payment_rules BEFORE INSERT OR UPDATE ON sales.payments
  FOR EACH ROW EXECUTE FUNCTION sales.payment_rules();
SELECT sys.add_stamp('sales.payments');
SELECT audit.enable_for('sales.payments');
SELECT sys.forbid_delete('sales.payments');
SELECT sys.add_immutable_guard('sales.payments', '', '', 'status,allocated_fils');

-- At commit: every payment is fully allocated and has its journal entry (0013, 0052).
CREATE FUNCTION sales.payment_commit_checks() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p record;
BEGIN
  SELECT * INTO p FROM sales.payments WHERE id = NEW.id;
  IF p.allocated_fils <> p.amount_fils THEN
    RAISE EXCEPTION 'Every payment must be fully allocated' USING ERRCODE = 'AP011', HINT = 'PAYMENT_UNALLOCATED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gl.journal_entries WHERE source_type = 'payment' AND payment_id = p.id) THEN
    RAISE EXCEPTION 'A payment needs its journal entry' USING ERRCODE = 'AP011', HINT = 'JOURNAL_MISSING';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER z_payment_commit AFTER INSERT ON sales.payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sales.payment_commit_checks();

-- ---------------------------------------------------------------------------------------------
-- Payment allocations: what each payment settles (append-only)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sales.payment_allocations (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id          bigint NOT NULL REFERENCES sales.payments (id),
  document_id         bigint REFERENCES sales.documents (id),
  opening_balance_id  bigint REFERENCES sales.opening_balances (id),
  amount_fils         bigint NOT NULL CHECK (amount_fils > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          bigint NOT NULL REFERENCES auth.users (id),
  CONSTRAINT payment_allocations_target_ck CHECK (num_nonnulls(document_id, opening_balance_id) = 1)
);
CREATE INDEX payment_allocations_payment_ix ON sales.payment_allocations (payment_id);
CREATE INDEX payment_allocations_document_ix ON sales.payment_allocations (document_id);

CREATE FUNCTION sales.payment_allocation_rules() RETURNS trigger
-- Runs with the owner's rights: it maintains amounts the API may never set itself.
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  p record;
  t record;
  v_left bigint;
  v_fits boolean;
BEGIN
  SELECT * INTO p FROM sales.payments WHERE id = NEW.payment_id FOR UPDATE;
  IF p.allocated_fils + NEW.amount_fils > p.amount_fils THEN
    RAISE EXCEPTION 'More is allocated than the payment' USING ERRCODE = 'AP011', HINT = 'ALLOCATION_EXCEEDS';
  END IF;

  IF NEW.document_id IS NOT NULL THEN
    SELECT id, customer_id, status, doc_type, total_fils, settled_fils INTO t
      FROM sales.documents WHERE id = NEW.document_id FOR UPDATE;
    v_fits := CASE p.payment_kind
                WHEN 'receipt' THEN t.doc_type IN ('invoice', 'advance_invoice', 'debit_note')
                WHEN 'refund' THEN t.doc_type = 'credit_note'
                ELSE true END;
    IF t.customer_id <> p.customer_id OR t.status <> 'issued' OR NOT v_fits THEN
      RAISE EXCEPTION 'A payment settles issued documents of its own customer' USING ERRCODE = 'AP011', HINT = 'ALLOCATION_TARGET';
    END IF;
    IF p.payment_kind = 'reversal' THEN
      -- A reversal takes back exactly what the reversed payment had settled on this document.
      SELECT coalesce(sum(amount_fils), 0) INTO v_left FROM sales.payment_allocations
       WHERE payment_id = p.reversal_of_id AND document_id = t.id;
      v_left := v_left - coalesce((SELECT sum(amount_fils) FROM sales.payment_allocations
                                    WHERE payment_id = p.id AND document_id = t.id), 0);
      IF NEW.amount_fils > v_left THEN
        RAISE EXCEPTION 'A reversal takes back only what was settled' USING ERRCODE = 'AP011', HINT = 'ALLOCATION_EXCEEDS';
      END IF;
      UPDATE sales.documents SET settled_fils = settled_fils - NEW.amount_fils WHERE id = t.id;
    ELSE
      IF t.settled_fils + NEW.amount_fils > t.total_fils THEN
        RAISE EXCEPTION 'More is settled than the document' USING ERRCODE = 'AP011', HINT = 'ALLOCATION_EXCEEDS';
      END IF;
      UPDATE sales.documents SET settled_fils = settled_fils + NEW.amount_fils WHERE id = t.id;
    END IF;
  ELSE
    SELECT id, customer_id, direction, amount_fils, settled_fils INTO t
      FROM sales.opening_balances WHERE id = NEW.opening_balance_id FOR UPDATE;
    v_fits := CASE p.payment_kind
                WHEN 'receipt' THEN t.direction = 'receivable'
                WHEN 'refund' THEN t.direction = 'payable'
                ELSE true END;
    IF t.customer_id <> p.customer_id OR NOT v_fits THEN
      RAISE EXCEPTION 'A payment settles opening balances of its own customer' USING ERRCODE = 'AP011', HINT = 'ALLOCATION_TARGET';
    END IF;
    IF p.payment_kind = 'reversal' THEN
      SELECT coalesce(sum(amount_fils), 0) INTO v_left FROM sales.payment_allocations
       WHERE payment_id = p.reversal_of_id AND opening_balance_id = t.id;
      IF NEW.amount_fils > v_left THEN
        RAISE EXCEPTION 'A reversal takes back only what was settled' USING ERRCODE = 'AP011', HINT = 'ALLOCATION_EXCEEDS';
      END IF;
      UPDATE sales.opening_balances SET settled_fils = settled_fils - NEW.amount_fils WHERE id = t.id;
    ELSE
      IF t.settled_fils + NEW.amount_fils > t.amount_fils THEN
        RAISE EXCEPTION 'More is settled than the opening balance' USING ERRCODE = 'AP011', HINT = 'ALLOCATION_EXCEEDS';
      END IF;
      UPDATE sales.opening_balances SET settled_fils = settled_fils + NEW.amount_fils WHERE id = t.id;
    END IF;
  END IF;
  UPDATE sales.payments SET allocated_fils = allocated_fils + NEW.amount_fils WHERE id = p.id;
  RETURN NEW;
END $$;
CREATE TRIGGER b_payment_allocation_rules BEFORE INSERT ON sales.payment_allocations
  FOR EACH ROW EXECUTE FUNCTION sales.payment_allocation_rules();
SELECT sys.add_stamp('sales.payment_allocations');
SELECT audit.enable_for('sales.payment_allocations');
SELECT sys.forbid_delete('sales.payment_allocations');
SELECT sys.add_immutable_guard('sales.payment_allocations', '', '', '');

-- ---------------------------------------------------------------------------------------------
-- Credit allocations: a credit note applied to an invoice or opening balance (append-only)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sales.credit_allocations (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  credit_note_id      bigint NOT NULL REFERENCES sales.documents (id),
  invoice_id          bigint REFERENCES sales.documents (id),
  opening_balance_id  bigint REFERENCES sales.opening_balances (id),
  amount_fils         bigint NOT NULL CHECK (amount_fils > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          bigint NOT NULL REFERENCES auth.users (id),
  CONSTRAINT credit_allocations_target_ck CHECK (num_nonnulls(invoice_id, opening_balance_id) = 1)
);
CREATE INDEX credit_allocations_note_ix ON sales.credit_allocations (credit_note_id);

CREATE FUNCTION sales.credit_allocation_rules() RETURNS trigger
-- Runs with the owner's rights: it maintains amounts the API may never set itself.
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n record;
  t record;
BEGIN
  SELECT id, customer_id, status, doc_type, total_fils, settled_fils INTO n
    FROM sales.documents WHERE id = NEW.credit_note_id FOR UPDATE;
  IF n.doc_type IS DISTINCT FROM 'credit_note' OR n.status <> 'issued' THEN
    RAISE EXCEPTION 'Only an issued credit note is applied' USING ERRCODE = 'AP011', HINT = 'ALLOCATION_TARGET';
  END IF;
  IF n.settled_fils + NEW.amount_fils > n.total_fils THEN
    RAISE EXCEPTION 'More is applied than the credit note' USING ERRCODE = 'AP011', HINT = 'ALLOCATION_EXCEEDS';
  END IF;
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT id, customer_id, status, doc_type, total_fils, settled_fils INTO t
      FROM sales.documents WHERE id = NEW.invoice_id FOR UPDATE;
    IF t.customer_id <> n.customer_id OR t.status <> 'issued' OR t.doc_type NOT IN ('invoice', 'debit_note') THEN
      RAISE EXCEPTION 'A credit note is applied to an issued invoice of its own customer'
        USING ERRCODE = 'AP011', HINT = 'ALLOCATION_TARGET';
    END IF;
    IF t.settled_fils + NEW.amount_fils > t.total_fils THEN
      RAISE EXCEPTION 'More is settled than the document' USING ERRCODE = 'AP011', HINT = 'ALLOCATION_EXCEEDS';
    END IF;
    UPDATE sales.documents SET settled_fils = settled_fils + NEW.amount_fils WHERE id = t.id;
  ELSE
    SELECT id, customer_id, direction, amount_fils, settled_fils INTO t
      FROM sales.opening_balances WHERE id = NEW.opening_balance_id FOR UPDATE;
    IF t.customer_id <> n.customer_id OR t.direction <> 'receivable' OR t.settled_fils + NEW.amount_fils > t.amount_fils THEN
      RAISE EXCEPTION 'A credit note is applied to what the customer owes' USING ERRCODE = 'AP011', HINT = 'ALLOCATION_TARGET';
    END IF;
    UPDATE sales.opening_balances SET settled_fils = settled_fils + NEW.amount_fils WHERE id = t.id;
  END IF;
  UPDATE sales.documents SET settled_fils = settled_fils + NEW.amount_fils WHERE id = n.id;
  RETURN NEW;
END $$;
CREATE TRIGGER b_credit_allocation_rules BEFORE INSERT ON sales.credit_allocations
  FOR EACH ROW EXECUTE FUNCTION sales.credit_allocation_rules();
SELECT sys.add_stamp('sales.credit_allocations');
SELECT audit.enable_for('sales.credit_allocations');
SELECT sys.forbid_delete('sales.credit_allocations');
SELECT sys.add_immutable_guard('sales.credit_allocations', '', '', '');

-- ---------------------------------------------------------------------------------------------
-- Held carts (POS, M5)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sales.held_carts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cart_id      uuid NOT NULL UNIQUE,
  device_id    bigint NOT NULL REFERENCES auth.devices (id),
  register_id  bigint REFERENCES cash.registers (id),
  user_id      bigint NOT NULL REFERENCES auth.users (id),
  customer_id  bigint REFERENCES md.customers (id),
  label        text CHECK (length(label) <= 100),
  cart         jsonb NOT NULL CHECK (jsonb_typeof(cart) = 'object'),
  status       text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'resumed', 'discarded')),
  held_at      timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  closed_by    bigint REFERENCES auth.users (id),
  CONSTRAINT held_carts_closed_ck CHECK ((status = 'held') = (closed_at IS NULL AND closed_by IS NULL))
);
SELECT sys.add_stamp('sales.held_carts', 'held_at', 'user_id');
SELECT audit.enable_for('sales.held_carts');
SELECT sys.forbid_delete('sales.held_carts');
SELECT sys.add_immutable_guard('sales.held_carts', 'status', 'held', '');

-- ---------------------------------------------------------------------------------------------
-- The links promised by 0011 and 0012
-- ---------------------------------------------------------------------------------------------
ALTER TABLE inv.adjustments
  ADD CONSTRAINT adjustments_sales_document_fk FOREIGN KEY (sales_document_id) REFERENCES sales.documents (id);
ALTER TABLE inv.movements
  ADD CONSTRAINT movements_sales_line_fk FOREIGN KEY (sales_document_line_id) REFERENCES sales.document_lines (id);
ALTER TABLE gl.journal_entries
  ADD CONSTRAINT journal_entries_sales_document_fk FOREIGN KEY (sales_document_id) REFERENCES sales.documents (id),
  ADD CONSTRAINT journal_entries_payment_fk FOREIGN KEY (payment_id) REFERENCES sales.payments (id),
  ADD CONSTRAINT journal_entries_opening_fk FOREIGN KEY (opening_balance_id) REFERENCES sales.opening_balances (id);

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON sales.quotations, sales.quotation_lines, sales.documents, sales.document_lines, sales.payments,
                sales.payment_allocations, sales.credit_allocations, sales.opening_balances, sales.held_carts
  TO artepool_api;
GRANT INSERT (branch_id, business_line_id, customer_id, bill_to_name, bill_to_name_alt, bill_to_trn, bill_to_address,
              bill_to_phone, quotation_date, valid_until, price_level_id, salesperson_id, subject, terms_ar,
              terms_en, notes, doc_discount_fils, revised_from_id)
  ON sales.quotations TO artepool_api;
GRANT UPDATE (status, business_line_id, customer_id, bill_to_name, bill_to_name_alt, bill_to_trn, bill_to_address,
              bill_to_phone, quotation_date, valid_until, salesperson_id, subject, terms_ar, terms_en, notes,
              doc_discount_fils, approval_id, converted_document_id)
  ON sales.quotations TO artepool_api;
GRANT INSERT (quotation_id, line_no, item_id, description_ar, description_en, unit_id, business_line_id, quantity,
              unit_price_4dp, line_discount_bp, line_discount_fils, doc_discount_alloc_fils, is_optional, note)
  ON sales.quotation_lines TO artepool_api;
GRANT UPDATE (line_no, description_ar, description_en, business_line_id, quantity, unit_price_4dp, line_discount_bp,
              line_discount_fils, doc_discount_alloc_fils, is_optional, note)
  ON sales.quotation_lines TO artepool_api;
GRANT DELETE ON sales.quotation_lines TO artepool_api;
GRANT INSERT (doc_type, channel, branch_id, business_line_id, warehouse_id, device_id, shift_id, pos_cart_id,
              customer_id, bill_to_name, bill_to_name_alt, bill_to_address, bill_to_phone, issue_date, supply_date,
              due_date, price_level_id, salesperson_id, quotation_id, original_document_id, reason_code_id,
              reason_text, approval_id, credit_approval_id, doc_discount_fils, notes, internal_note)
  ON sales.documents TO artepool_api;
GRANT UPDATE (status, business_line_id, customer_id, bill_to_name, bill_to_name_alt, bill_to_address, bill_to_phone,
              issue_date, supply_date, due_date, salesperson_id, reason_code_id, reason_text, approval_id,
              credit_approval_id, doc_discount_fils, content_hash, print_count, notes, internal_note)
  ON sales.documents TO artepool_api;
GRANT INSERT (document_id, line_no, line_kind, item_id, description_ar, description_en, unit_id, business_line_id,
              quantity, unit_price_4dp, price_override_approval_id, line_discount_bp, line_discount_fils,
              doc_discount_alloc_fils, vat_category_id, net_fils, vat_fils, gross_fils, cost_fils,
              advance_document_id, original_line_id, return_stock_status, technician_id, note)
  ON sales.document_lines TO artepool_api;
GRANT UPDATE (line_no, description_ar, description_en, business_line_id, quantity, unit_price_4dp,
              price_override_approval_id, line_discount_bp, line_discount_fils, doc_discount_alloc_fils, cost_fils,
              technician_id, note)
  ON sales.document_lines TO artepool_api;
GRANT DELETE ON sales.document_lines TO artepool_api;
GRANT INSERT (payment_kind, reversal_of_id, customer_id, payment_method_id, amount_fils, tendered_fils, change_fils,
              reference, cheque_date, cheque_bank, payment_date, channel, device_id, shift_id, reason_code_id,
              approval_id, quotation_id, notes)
  ON sales.payments TO artepool_api;
GRANT INSERT (payment_id, document_id, opening_balance_id, amount_fils) ON sales.payment_allocations TO artepool_api;
GRANT INSERT (credit_note_id, invoice_id, opening_balance_id, amount_fils) ON sales.credit_allocations TO artepool_api;
GRANT INSERT (customer_id, balance_date, direction, amount_fils, reference, due_date, import_batch_id)
  ON sales.opening_balances TO artepool_api;
GRANT INSERT (cart_id, device_id, register_id, customer_id, label, cart) ON sales.held_carts TO artepool_api;
GRANT UPDATE (status, closed_at, closed_by, cart, label, customer_id) ON sales.held_carts TO artepool_api;
GRANT EXECUTE ON FUNCTION sales.line_amounts(numeric, bigint, boolean, integer, bigint, bigint),
                          sales.customer_balance(bigint), sales.discount_limit(bigint),
                          sales.series_for(text, text), sales.quotation_totals(bigint)
  TO artepool_api;
