-- 0009_master_data.sql
-- Purpose: master data (docs/database-schema.md §7) and reason codes (§4.6), with their seeds
-- (§15.3), and the M2 decisions:
--   0031 import (no schema change), 0032 one sale price per item with a "price includes VAT"
--   switch, stored per price level, and customer types; 0033 four fixed UAE VAT categories with
--   owner-only rate changes; 0036 customers start as cash, credit needs `customers.credit` and a
--   reason; 0037 item codes fixed, unique phones and TRNs (15 digits starting with 100), PNG/JPEG
--   logo, deactivation with a reason.
-- Also: the two foreign keys M1 left open (PC → default warehouse, approval → reason code), more
-- reasons an account is in use, and numbering series whose prefix can change until first use.
-- Rule errors use SQLSTATE AP011 (rule) or AP012 (permission) with a machine-readable HINT.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0009: master data and reason codes');

-- ---------------------------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------------------------

-- Deactivating needs a written reason (decision 0037); it is stored in the audit log entry.
CREATE FUNCTION sys.require_reason_to_deactivate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_active AND NOT NEW.is_active AND sys.ctx_reason() IS NULL THEN
    RAISE EXCEPTION 'Deactivating needs a reason' USING ERRCODE = 'AP011', HINT = 'REASON_REQUIRED';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION sys.add_deactivation_reason(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER b_deactivation_reason BEFORE UPDATE OF is_active ON %s '
                 'FOR EACH ROW EXECUTE FUNCTION sys.require_reason_to_deactivate()', p_table);
END $$;

SELECT sys.add_deactivation_reason('gl.accounts');

-- An active, postable, non-control account of the given type (for lines of business, payment
-- methods and reason codes), or an error with the given hint.
CREATE FUNCTION gl.assert_plain_account(p_account_id bigint, p_types text[], p_hint text) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_account gl.accounts;
BEGIN
  SELECT * INTO v_account FROM gl.accounts WHERE id = p_account_id;
  IF NOT v_account.is_active OR NOT v_account.is_postable OR v_account.is_control
     OR NOT (v_account.account_type = ANY (p_types)) THEN
    RAISE EXCEPTION 'Account % must be active, postable, not a control account, and of type %',
      v_account.code, array_to_string(p_types, ' or ') USING ERRCODE = 'AP011', HINT = p_hint;
  END IF;
END $$;

-- A quantity must fit the unit's decimals (pieces 0, kilograms 3).
CREATE FUNCTION md.assert_unit_decimals(p_quantity numeric, p_unit_id bigint) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_decimals smallint := (SELECT decimals FROM md.units WHERE id = p_unit_id);
BEGIN
  IF p_quantity IS NOT NULL AND p_quantity * (10::numeric ^ v_decimals)
                                <> trunc(p_quantity * (10::numeric ^ v_decimals)) THEN
    RAISE EXCEPTION 'Quantity % has more decimals than its unit allows (%)', p_quantity, v_decimals
      USING ERRCODE = 'AP011', HINT = 'QUANTITY_DECIMALS';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Units
-- ---------------------------------------------------------------------------------------------
CREATE TABLE md.units (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code           text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name_ar        text NOT NULL CHECK (btrim(name_ar) <> ''),
  name_en        text NOT NULL CHECK (btrim(name_en) <> ''),
  decimals       smallint NOT NULL CHECK (decimals BETWEEN 0 AND 3),
  einvoice_code  text CHECK (einvoice_code ~ '^[A-Z0-9]{1,3}$'),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     bigint NOT NULL REFERENCES auth.users (id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint NOT NULL REFERENCES auth.users (id),
  row_version    integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX units_code_uq ON md.units (lower(code));
SELECT sys.add_touch('md.units');
SELECT sys.add_deactivation_reason('md.units');
SELECT audit.enable_for('md.units');
SELECT sys.forbid_delete('md.units');

-- UN/ECE Rec 20 codes are filled only where certain; the rest wait for the e-invoicing provider.
INSERT INTO md.units (code, name_ar, name_en, decimals, einvoice_code) VALUES
  ('PCS', 'قطعة', 'Piece', 0, 'H87'),
  ('BOX', 'علبة', 'Box', 0, NULL),
  ('BAG', 'كيس', 'Bag', 0, NULL),
  ('BTL', 'عبوة', 'Bottle', 0, NULL),
  ('SET', 'طقم', 'Set', 0, NULL),
  ('KG', 'كيلوغرام', 'Kilogram', 3, 'KGM'),
  ('L', 'لتر', 'Litre', 3, 'LTR'),
  ('M', 'متر', 'Metre', 2, 'MTR'),
  ('M2', 'متر مربع', 'Square metre', 2, 'MTK'),
  ('HR', 'ساعة', 'Hour', 2, 'HUR'),
  ('VISIT', 'زيارة', 'Visit', 0, NULL),
  ('JOB', 'عمل', 'Job', 0, NULL);

-- ---------------------------------------------------------------------------------------------
-- VAT categories: exactly the four UAE treatments; only the owner changes a rate (decision 0033)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE md.vat_categories (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code           text NOT NULL UNIQUE,
  name_ar        text NOT NULL CHECK (btrim(name_ar) <> ''),
  name_en        text NOT NULL CHECK (btrim(name_en) <> ''),
  rate_bp        integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  einvoice_code  text NOT NULL CHECK (einvoice_code IN ('S', 'Z', 'E', 'O')),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     bigint NOT NULL REFERENCES auth.users (id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint NOT NULL REFERENCES auth.users (id),
  row_version    integer NOT NULL DEFAULT 1,
  CONSTRAINT vat_code_ck CHECK ((code, einvoice_code) IN (('SR', 'S'), ('ZR', 'Z'), ('EX', 'E'), ('OS', 'O'))),
  -- Standard is always above 0%; zero-rated, exempt and out of scope are always 0%.
  CONSTRAINT vat_rate_ck CHECK ((einvoice_code = 'S') = (rate_bp > 0))
);

CREATE FUNCTION md.guard_vat_category() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.code, NEW.einvoice_code, NEW.is_active) IS DISTINCT FROM (OLD.code, OLD.einvoice_code, OLD.is_active) THEN
    RAISE EXCEPTION 'The four VAT categories are fixed; only a rate can change' USING ERRCODE = 'AP003';
  END IF;
  IF NEW.rate_bp <> OLD.rate_bp THEN
    IF NOT auth.user_has_permission(sys.require_user(), 'system.settings.edit') THEN
      RAISE EXCEPTION 'Only the owner can change a VAT rate' USING ERRCODE = 'AP012', HINT = 'VAT_RATE_OWNER_ONLY';
    END IF;
    IF sys.ctx_reason() IS NULL THEN
      RAISE EXCEPTION 'Changing a VAT rate needs a reason' USING ERRCODE = 'AP011', HINT = 'REASON_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_guard_vat_category BEFORE UPDATE ON md.vat_categories
  FOR EACH ROW EXECUTE FUNCTION md.guard_vat_category();
SELECT sys.add_touch('md.vat_categories');
SELECT audit.enable_for('md.vat_categories');
SELECT sys.forbid_delete('md.vat_categories');

INSERT INTO md.vat_categories (code, name_ar, name_en, rate_bp, einvoice_code) VALUES
  ('SR', 'خاضع للنسبة الأساسية', 'Standard rated', 500, 'S'),
  ('ZR', 'خاضع لنسبة الصفر', 'Zero-rated', 0, 'Z'),
  ('EX', 'معفى', 'Exempt', 0, 'E'),
  ('OS', 'خارج نطاق الضريبة', 'Out of scope', 0, 'O');

-- ---------------------------------------------------------------------------------------------
-- Lines of business (decision 0018): each has its revenue and cost-of-sales account
-- ---------------------------------------------------------------------------------------------
CREATE TABLE md.business_lines (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name_ar             text NOT NULL CHECK (btrim(name_ar) <> ''),
  name_en             text NOT NULL CHECK (btrim(name_en) <> ''),
  revenue_account_id  bigint NOT NULL REFERENCES gl.accounts (id),
  cogs_account_id     bigint NOT NULL REFERENCES gl.accounts (id),
  sort_order          integer NOT NULL DEFAULT 0,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          bigint NOT NULL REFERENCES auth.users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          bigint NOT NULL REFERENCES auth.users (id),
  row_version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX business_lines_code_uq ON md.business_lines (lower(code));

CREATE FUNCTION md.business_line_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'The code of a line of business cannot change' USING ERRCODE = 'AP011', HINT = 'CODE_FIXED';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.revenue_account_id <> OLD.revenue_account_id OR NEW.is_active THEN
    PERFORM gl.assert_plain_account(NEW.revenue_account_id, ARRAY['revenue'], 'BUSINESS_LINE_ACCOUNT_INVALID');
  END IF;
  IF TG_OP = 'INSERT' OR NEW.cogs_account_id <> OLD.cogs_account_id OR NEW.is_active THEN
    PERFORM gl.assert_plain_account(NEW.cogs_account_id, ARRAY['expense'], 'BUSINESS_LINE_ACCOUNT_INVALID');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_business_line_rules BEFORE INSERT OR UPDATE ON md.business_lines
  FOR EACH ROW EXECUTE FUNCTION md.business_line_rules();
SELECT sys.add_touch('md.business_lines');
SELECT sys.add_deactivation_reason('md.business_lines');
SELECT audit.enable_for('md.business_lines');
SELECT sys.forbid_delete('md.business_lines');

INSERT INTO md.business_lines (code, name_ar, name_en, revenue_account_id, cogs_account_id, sort_order)
SELECT b.code, b.name_ar, b.name_en, r.id, c.id, b.sort_order
  FROM (VALUES ('supplies', 'مستلزمات المسابح', 'Pool supplies', '4100', '5100', 1),
               ('construction', 'إنشاء المسابح', 'Pool construction', '4200', '5200', 2),
               ('maintenance', 'صيانة المسابح', 'Pool maintenance', '4300', '5300', 3),
               ('cleaning', 'تنظيف المسابح', 'Pool cleaning', '4400', '5400', 4))
       AS b(code, name_ar, name_en, revenue, cogs, sort_order)
  JOIN gl.accounts AS r ON r.code = b.revenue
  JOIN gl.accounts AS c ON c.code = b.cogs;

-- ---------------------------------------------------------------------------------------------
-- Item categories (a tree)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE md.item_categories (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id    bigint REFERENCES md.item_categories (id),
  code         text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name_ar      text NOT NULL CHECK (btrim(name_ar) <> ''),
  name_en      text NOT NULL CHECK (btrim(name_en) <> ''),
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint NOT NULL REFERENCES auth.users (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint NOT NULL REFERENCES auth.users (id),
  row_version  integer NOT NULL DEFAULT 1,
  CONSTRAINT item_categories_parent_ck CHECK (parent_id <> id)
);
CREATE UNIQUE INDEX item_categories_code_uq ON md.item_categories (lower(code));
CREATE INDEX item_categories_parent_ix ON md.item_categories (parent_id);
SELECT sys.add_touch('md.item_categories');
SELECT sys.add_deactivation_reason('md.item_categories');
SELECT audit.enable_for('md.item_categories');
SELECT sys.forbid_delete('md.item_categories');

INSERT INTO md.item_categories (code, name_ar, name_en, sort_order) VALUES
  ('CHEM', 'كيماويات', 'Chemicals', 1),
  ('EQUIP', 'معدات', 'Equipment', 2),
  ('CLEAN', 'أدوات التنظيف', 'Cleaning', 3),
  ('PARTS', 'قطع غيار', 'Spare parts', 4),
  ('SERV', 'خدمات', 'Services', 5);

-- ---------------------------------------------------------------------------------------------
-- Items: stock item, service or kit (bundle). The code never changes (decision 0037); the type
-- is fixed once the item is used. Prices live in md.item_prices (decision 0032).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE md.items (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                      text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  item_type                 text NOT NULL CHECK (item_type IN ('stock', 'service', 'bundle')),
  name_ar                   text NOT NULL CHECK (btrim(name_ar) <> ''),
  name_en                   text NOT NULL CHECK (btrim(name_en) <> ''),
  description_ar            text,
  description_en            text,
  search_key                text GENERATED ALWAYS AS (
                              sys.normalize_search(code || ' ' || name_ar || ' ' || name_en)) STORED,
  category_id               bigint NOT NULL REFERENCES md.item_categories (id),
  unit_id                   bigint NOT NULL REFERENCES md.units (id),
  vat_category_id           bigint NOT NULL REFERENCES md.vat_categories (id),
  default_business_line_id  bigint REFERENCES md.business_lines (id),
  reorder_level             numeric(14,3) CHECK (reorder_level >= 0),
  reorder_qty               numeric(14,3) CHECK (reorder_qty > 0),
  fallback_unit_cost_4dp    bigint CHECK (fallback_unit_cost_4dp >= 0),
  is_sellable               boolean NOT NULL DEFAULT true,
  is_active                 boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                bigint NOT NULL REFERENCES auth.users (id),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                bigint NOT NULL REFERENCES auth.users (id),
  row_version               integer NOT NULL DEFAULT 1,
  -- Only stock items have stock settings.
  CONSTRAINT items_stock_fields_ck CHECK (
    item_type = 'stock' OR (reorder_level IS NULL AND reorder_qty IS NULL AND fallback_unit_cost_4dp IS NULL))
);
CREATE UNIQUE INDEX items_code_uq ON md.items (lower(code));
CREATE INDEX items_search_ix ON md.items USING gin (search_key gin_trgm_ops);
CREATE INDEX items_category_ix ON md.items (category_id);

-- Why an item is in use, or NULL. A used item keeps its type. Replaced by later migrations
-- (0010: stock movements; 0013: quotation and document lines).
CREATE FUNCTION md.item_in_use(p_item_id bigint) RETURNS text
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM md.bundle_components WHERE component_item_id = p_item_id) THEN
    RETURN 'kit_component';
  END IF;
  IF EXISTS (SELECT 1 FROM md.bundle_components WHERE bundle_item_id = p_item_id) THEN
    RETURN 'kit_contents';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION md.item_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_use text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.code <> OLD.code THEN
      RAISE EXCEPTION 'The code of an item never changes' USING ERRCODE = 'AP011', HINT = 'CODE_FIXED';
    END IF;
    IF NEW.item_type <> OLD.item_type THEN
      v_use := md.item_in_use(NEW.id);
      IF v_use IS NOT NULL THEN
        RAISE EXCEPTION 'Item % is in use (%), so its type cannot change', NEW.code, v_use
          USING ERRCODE = 'AP011', HINT = 'ITEM_TYPE_FIXED', DETAIL = v_use;
      END IF;
    END IF;
    IF OLD.is_active AND NOT NEW.is_active AND EXISTS (
         SELECT 1 FROM md.bundle_components AS c JOIN md.items AS k ON k.id = c.bundle_item_id
          WHERE c.component_item_id = NEW.id AND k.is_active) THEN
      RAISE EXCEPTION 'Item % is part of an active kit', NEW.code USING ERRCODE = 'AP011', HINT = 'ITEM_IN_ACTIVE_KIT';
    END IF;
  END IF;
  IF NEW.is_active THEN
    IF NOT (SELECT is_active FROM md.item_categories WHERE id = NEW.category_id)
       OR NOT (SELECT is_active FROM md.units WHERE id = NEW.unit_id)
       OR NOT (SELECT is_active FROM md.vat_categories WHERE id = NEW.vat_category_id)
       OR NOT coalesce((SELECT is_active FROM md.business_lines WHERE id = NEW.default_business_line_id), true) THEN
      RAISE EXCEPTION 'Item % uses an inactive category, unit, VAT category or line of business', NEW.code
        USING ERRCODE = 'AP011', HINT = 'REFERENCE_INACTIVE';
    END IF;
  END IF;
  PERFORM md.assert_unit_decimals(NEW.reorder_level, NEW.unit_id);
  PERFORM md.assert_unit_decimals(NEW.reorder_qty, NEW.unit_id);
  RETURN NEW;
END $$;
CREATE TRIGGER b_item_rules BEFORE INSERT OR UPDATE ON md.items
  FOR EACH ROW EXECUTE FUNCTION md.item_rules();
SELECT sys.add_touch('md.items');
SELECT sys.add_deactivation_reason('md.items');
SELECT audit.enable_for('md.items', p_ignored => ARRAY['search_key']);
SELECT sys.forbid_delete('md.items');

-- Categories, units and lines of business in use by active items stay active; a category keeps
-- its tree sound (no loops, nothing active under an inactive parent).
CREATE FUNCTION md.item_category_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.is_active AND NOT (SELECT is_active FROM md.item_categories WHERE id = NEW.parent_id) THEN
      RAISE EXCEPTION 'Category % cannot be active under an inactive category', NEW.code
        USING ERRCODE = 'AP011', HINT = 'REFERENCE_INACTIVE';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id AND EXISTS (
         WITH RECURSIVE up AS (
           SELECT c.id, c.parent_id FROM md.item_categories AS c WHERE c.id = NEW.parent_id
           UNION ALL
           SELECT c.id, c.parent_id FROM md.item_categories AS c JOIN up ON c.id = up.parent_id)
         SELECT 1 FROM up WHERE up.id = NEW.id) THEN
      RAISE EXCEPTION 'Category % cannot sit under one of its own sub-categories', NEW.code
        USING ERRCODE = 'AP011', HINT = 'CATEGORY_LOOP';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_active AND NOT NEW.is_active THEN
    IF EXISTS (SELECT 1 FROM md.item_categories WHERE parent_id = NEW.id AND is_active)
       OR EXISTS (SELECT 1 FROM md.items WHERE category_id = NEW.id AND is_active) THEN
      RAISE EXCEPTION 'Category % still has active sub-categories or items', NEW.code
        USING ERRCODE = 'AP011', HINT = 'STILL_USED';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_item_category_rules BEFORE INSERT OR UPDATE ON md.item_categories
  FOR EACH ROW EXECUTE FUNCTION md.item_category_rules();

CREATE FUNCTION md.unit_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_active AND NOT NEW.is_active
     AND EXISTS (SELECT 1 FROM md.items WHERE unit_id = NEW.id AND is_active) THEN
    RAISE EXCEPTION 'Unit % is used by active items', NEW.code USING ERRCODE = 'AP011', HINT = 'STILL_USED';
  END IF;
  IF NEW.decimals < OLD.decimals AND EXISTS (SELECT 1 FROM md.items WHERE unit_id = NEW.id) THEN
    RAISE EXCEPTION 'Unit % is used by items, so it cannot take fewer decimals', NEW.code
      USING ERRCODE = 'AP011', HINT = 'STILL_USED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_unit_rules BEFORE UPDATE ON md.units FOR EACH ROW EXECUTE FUNCTION md.unit_rules();

CREATE FUNCTION md.business_line_in_use() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_active AND NOT NEW.is_active
     AND EXISTS (SELECT 1 FROM md.items WHERE default_business_line_id = NEW.id AND is_active) THEN
    RAISE EXCEPTION 'Line of business % is used by active items', NEW.code
      USING ERRCODE = 'AP011', HINT = 'STILL_USED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_business_line_in_use BEFORE UPDATE ON md.business_lines
  FOR EACH ROW EXECUTE FUNCTION md.business_line_in_use();

-- ---------------------------------------------------------------------------------------------
-- Barcodes: a barcode belongs to one active item; one primary barcode per item
-- ---------------------------------------------------------------------------------------------
CREATE TABLE md.item_barcodes (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id       bigint NOT NULL REFERENCES md.items (id),
  barcode       text NOT NULL CHECK (barcode ~ '^[0-9A-Za-z.\-]{3,64}$'),
  qty_per_scan  numeric(14,3) NOT NULL DEFAULT 1 CHECK (qty_per_scan > 0),
  is_primary    boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint NOT NULL REFERENCES auth.users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint NOT NULL REFERENCES auth.users (id),
  row_version   integer NOT NULL DEFAULT 1,
  CONSTRAINT item_barcodes_primary_ck CHECK (is_active OR NOT is_primary)
);
CREATE UNIQUE INDEX item_barcodes_active_uq ON md.item_barcodes (upper(barcode)) WHERE is_active;
CREATE UNIQUE INDEX item_barcodes_primary_uq ON md.item_barcodes (item_id) WHERE is_primary;
CREATE INDEX item_barcodes_item_ix ON md.item_barcodes (item_id);

CREATE FUNCTION md.item_barcode_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.item_id, NEW.barcode) IS DISTINCT FROM (OLD.item_id, OLD.barcode) THEN
    RAISE EXCEPTION 'A barcode cannot move or change; deactivate it and add a new one' USING ERRCODE = 'AP003';
  END IF;
  PERFORM md.assert_unit_decimals(NEW.qty_per_scan, (SELECT unit_id FROM md.items WHERE id = NEW.item_id));
  RETURN NEW;
END $$;
CREATE TRIGGER b_item_barcode_rules BEFORE INSERT OR UPDATE ON md.item_barcodes
  FOR EACH ROW EXECUTE FUNCTION md.item_barcode_rules();
SELECT sys.add_touch('md.item_barcodes');
SELECT audit.enable_for('md.item_barcodes');
SELECT sys.forbid_delete('md.item_barcodes');

-- ---------------------------------------------------------------------------------------------
-- Kit components (link table: removing a component is allowed and audited)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE md.bundle_components (
  bundle_item_id     bigint NOT NULL REFERENCES md.items (id),
  component_item_id  bigint NOT NULL REFERENCES md.items (id),
  quantity           numeric(14,3) NOT NULL CHECK (quantity > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         bigint NOT NULL REFERENCES auth.users (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         bigint NOT NULL REFERENCES auth.users (id),
  row_version        integer NOT NULL DEFAULT 1,
  PRIMARY KEY (bundle_item_id, component_item_id),
  CONSTRAINT bundle_self_ck CHECK (bundle_item_id <> component_item_id)
);
CREATE INDEX bundle_components_component_ix ON md.bundle_components (component_item_id);

CREATE FUNCTION md.bundle_component_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.bundle_item_id, NEW.component_item_id)
                          IS DISTINCT FROM (OLD.bundle_item_id, OLD.component_item_id) THEN
    RAISE EXCEPTION 'Only the quantity of a kit component can change' USING ERRCODE = 'AP003';
  END IF;
  IF (SELECT item_type FROM md.items WHERE id = NEW.bundle_item_id) <> 'bundle' THEN
    RAISE EXCEPTION 'Only a kit has components' USING ERRCODE = 'AP011', HINT = 'KIT_RULE';
  END IF;
  IF (SELECT item_type FROM md.items WHERE id = NEW.component_item_id) = 'bundle' THEN
    RAISE EXCEPTION 'A kit cannot contain another kit' USING ERRCODE = 'AP011', HINT = 'KIT_RULE';
  END IF;
  IF NOT (SELECT is_active FROM md.items WHERE id = NEW.component_item_id) THEN
    RAISE EXCEPTION 'A kit component must be active' USING ERRCODE = 'AP011', HINT = 'REFERENCE_INACTIVE';
  END IF;
  PERFORM md.assert_unit_decimals(NEW.quantity, (SELECT unit_id FROM md.items WHERE id = NEW.component_item_id));
  RETURN NEW;
END $$;
CREATE TRIGGER b_bundle_component_rules BEFORE INSERT OR UPDATE OR DELETE ON md.bundle_components
  FOR EACH ROW EXECUTE FUNCTION md.bundle_component_rules();
SELECT sys.add_touch('md.bundle_components');
SELECT audit.enable_for('md.bundle_components', p_keys => ARRAY['bundle_item_id', 'component_item_id']);
SELECT sys.forbid_delete('md.bundle_components', p_allow_delete => true);

-- ---------------------------------------------------------------------------------------------
-- Price levels and item prices (decision 0032). One level now: STANDARD (the default, for every
-- customer). A later level may list customer types; each type is on at most one active level.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE md.price_levels (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name_ar         text NOT NULL CHECK (btrim(name_ar) <> ''),
  name_en         text NOT NULL CHECK (btrim(name_en) <> ''),
  is_default      boolean NOT NULL DEFAULT false,
  customer_types  text[] NOT NULL DEFAULT '{}'
                  CHECK (customer_types <@ ARRAY['individual', 'contractor', 'company']::text[]),
  sort_order      integer NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      bigint NOT NULL REFERENCES auth.users (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      bigint NOT NULL REFERENCES auth.users (id),
  row_version     integer NOT NULL DEFAULT 1,
  -- The default level applies to everyone, so it lists no customer types.
  CONSTRAINT price_levels_default_ck CHECK (NOT is_default OR (is_active AND customer_types = '{}'))
);
CREATE UNIQUE INDEX price_levels_code_uq ON md.price_levels (lower(code));
CREATE UNIQUE INDEX price_levels_default_uq ON md.price_levels ((true)) WHERE is_default;

CREATE FUNCTION md.price_level_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.is_default AND NOT NEW.is_default THEN
    RAISE EXCEPTION 'There must always be a default price level' USING ERRCODE = 'AP011', HINT = 'DEFAULT_REQUIRED';
  END IF;
  IF NEW.is_active AND EXISTS (
       SELECT 1 FROM md.price_levels
        WHERE id <> NEW.id AND is_active AND customer_types && NEW.customer_types) THEN
    RAISE EXCEPTION 'A customer type can be on one active price level only'
      USING ERRCODE = 'AP011', HINT = 'PRICE_LEVEL_TYPE_TAKEN';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_price_level_rules BEFORE INSERT OR UPDATE ON md.price_levels
  FOR EACH ROW EXECUTE FUNCTION md.price_level_rules();
SELECT sys.add_touch('md.price_levels');
SELECT sys.add_deactivation_reason('md.price_levels');
SELECT audit.enable_for('md.price_levels');
SELECT sys.forbid_delete('md.price_levels');

INSERT INTO md.price_levels (code, name_ar, name_en, is_default, sort_order)
VALUES ('STANDARD', 'السعر العادي', 'Standard price', true, 1);

CREATE TABLE md.item_prices (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  price_level_id  bigint NOT NULL REFERENCES md.price_levels (id),
  item_id         bigint NOT NULL REFERENCES md.items (id),
  price_4dp       bigint NOT NULL CHECK (price_4dp >= 0),
  -- "Price includes VAT": inclusive prices are split back into net and VAT (decisions 0009, 0032).
  includes_vat    boolean NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      bigint NOT NULL REFERENCES auth.users (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      bigint NOT NULL REFERENCES auth.users (id),
  row_version     integer NOT NULL DEFAULT 1,
  CONSTRAINT item_prices_uq UNIQUE (price_level_id, item_id)
);
CREATE INDEX item_prices_item_ix ON md.item_prices (item_id);
SELECT sys.add_touch('md.item_prices');
SELECT sys.add_immutable_guard('md.item_prices', '', '', 'price_4dp,includes_vat');
SELECT audit.enable_for('md.item_prices');
SELECT sys.forbid_delete('md.item_prices');

-- ---------------------------------------------------------------------------------------------
-- Customers (decisions 0010, 0032, 0036, 0037)
-- ---------------------------------------------------------------------------------------------
CREATE SEQUENCE md.customer_code_seq;

CREATE TABLE md.customers (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  customer_type       text NOT NULL CHECK (customer_type IN ('individual', 'contractor', 'company')),
  name                text NOT NULL CHECK (btrim(name) <> ''),
  name_alt            text CHECK (btrim(name_alt) <> ''),
  search_key          text GENERATED ALWAYS AS (sys.normalize_search(
                        code || ' ' || name || ' ' || coalesce(name_alt, '') || ' '
                        || coalesce(regexp_replace(phone, '^\+971', '0'), '') || ' ' || coalesce(phone, '') || ' '
                        || coalesce(regexp_replace(phone_alt, '^\+971', '0'), '') || ' '
                        || coalesce(trn::text, ''))) STORED,
  is_vat_registered   boolean NOT NULL DEFAULT false,
  trn                 char(15) CHECK (trn ~ '^100[0-9]{12}$'),
  phone               text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  phone_alt           text CHECK (phone_alt ~ '^\+[1-9][0-9]{7,14}$'),
  email               text CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address_line        text,
  area                text,
  city                text,
  po_box              text,
  emirate             text CHECK (emirate IN ('abu_dhabi', 'dubai', 'sharjah', 'ajman', 'umm_al_quwain',
                                             'ras_al_khaimah', 'fujairah')),
  country_code        char(2) NOT NULL DEFAULT 'AE' CHECK (country_code ~ '^[A-Z]{2}$'),
  credit_mode         text NOT NULL DEFAULT 'cash' CHECK (credit_mode IN ('cash', 'credit')),
  payment_terms_days  smallint NOT NULL DEFAULT 0,
  credit_limit_fils   bigint NOT NULL DEFAULT 0,
  is_walk_in          boolean NOT NULL DEFAULT false,
  preferred_language  text CHECK (preferred_language IN ('ar', 'en')),
  notes               text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          bigint NOT NULL REFERENCES auth.users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          bigint NOT NULL REFERENCES auth.users (id),
  row_version         integer NOT NULL DEFAULT 1,
  -- A TRN exactly when VAT-registered: it decides the invoice format (decision 0010).
  CONSTRAINT customers_trn_ck CHECK (is_vat_registered = (trn IS NOT NULL)),
  -- Every customer has a phone, except the walk-in "Cash customer" (decision 0037).
  CONSTRAINT customers_phone_ck CHECK (is_walk_in OR phone IS NOT NULL),
  -- Cash: no credit at all. Credit: a limit above 0 and terms of 0–365 days (decision 0036).
  CONSTRAINT customers_credit_ck CHECK (
    (credit_mode = 'cash' AND payment_terms_days = 0 AND credit_limit_fils = 0)
    OR (credit_mode = 'credit' AND credit_limit_fils > 0 AND payment_terms_days BETWEEN 0 AND 365)),
  CONSTRAINT customers_walk_in_ck CHECK (
    NOT is_walk_in OR (credit_mode = 'cash' AND NOT is_vat_registered AND customer_type = 'individual'))
);
CREATE UNIQUE INDEX customers_code_uq ON md.customers (lower(code));
CREATE UNIQUE INDEX customers_phone_uq ON md.customers (phone);
CREATE UNIQUE INDEX customers_trn_uq ON md.customers (trn);
CREATE UNIQUE INDEX customers_walk_in_uq ON md.customers ((true)) WHERE is_walk_in;
CREATE INDEX customers_search_ix ON md.customers USING gin (search_key gin_trgm_ops);

CREATE FUNCTION md.customer_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_code text;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.code IS NULL THEN
    LOOP
      v_code := 'C' || lpad(nextval('md.customer_code_seq')::text, 5, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM md.customers WHERE lower(code) = lower(v_code));
    END LOOP;
    NEW.code := v_code;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.is_walk_in THEN
      RAISE EXCEPTION 'The walk-in customer cannot be changed' USING ERRCODE = 'AP011', HINT = 'WALK_IN_LOCKED';
    END IF;
    IF NEW.code <> OLD.code OR NEW.is_walk_in <> OLD.is_walk_in THEN
      RAISE EXCEPTION 'The code of a customer never changes' USING ERRCODE = 'AP011', HINT = 'CODE_FIXED';
    END IF;
  END IF;
  -- Credit is given only by someone with `customers.credit`, with a reason (decision 0036).
  IF (TG_OP = 'INSERT' AND NEW.credit_mode <> 'cash')
     OR (TG_OP = 'UPDATE' AND (NEW.credit_mode, NEW.payment_terms_days, NEW.credit_limit_fils)
                              IS DISTINCT FROM (OLD.credit_mode, OLD.payment_terms_days, OLD.credit_limit_fils)) THEN
    IF NOT auth.user_has_permission(sys.require_user(), 'customers.credit') THEN
      RAISE EXCEPTION 'Changing a customer''s credit needs the customers.credit permission'
        USING ERRCODE = 'AP012', HINT = 'CREDIT_PERMISSION';
    END IF;
    IF sys.ctx_reason() IS NULL THEN
      RAISE EXCEPTION 'Changing a customer''s credit needs a reason' USING ERRCODE = 'AP011', HINT = 'REASON_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_customer_rules BEFORE INSERT OR UPDATE ON md.customers
  FOR EACH ROW EXECUTE FUNCTION md.customer_rules();
SELECT sys.add_touch('md.customers');
SELECT sys.add_deactivation_reason('md.customers');
SELECT audit.enable_for('md.customers', p_ignored => ARRAY['search_key']);
SELECT sys.forbid_delete('md.customers');

INSERT INTO md.customers (code, customer_type, name, name_alt, is_walk_in)
VALUES ('WALK-IN', 'individual', 'عميل نقدي', 'Cash customer', true);

-- ---------------------------------------------------------------------------------------------
-- Suppliers (purchasing comes in P2)
-- ---------------------------------------------------------------------------------------------
CREATE SEQUENCE md.supplier_code_seq;

CREATE TABLE md.suppliers (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name                text NOT NULL CHECK (btrim(name) <> ''),
  name_alt            text CHECK (btrim(name_alt) <> ''),
  search_key          text GENERATED ALWAYS AS (sys.normalize_search(
                        code || ' ' || name || ' ' || coalesce(name_alt, '') || ' '
                        || coalesce(regexp_replace(phone, '^\+971', '0'), '') || ' ' || coalesce(phone, '') || ' '
                        || coalesce(trn::text, ''))) STORED,
  is_vat_registered   boolean NOT NULL DEFAULT false,
  trn                 char(15) CHECK (trn ~ '^100[0-9]{12}$'),
  phone               text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  email               text CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address_line        text,
  city                text,
  emirate             text CHECK (emirate IN ('abu_dhabi', 'dubai', 'sharjah', 'ajman', 'umm_al_quwain',
                                             'ras_al_khaimah', 'fujairah')),
  country_code        char(2) NOT NULL DEFAULT 'AE' CHECK (country_code ~ '^[A-Z]{2}$'),
  payment_terms_days  smallint NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  notes               text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          bigint NOT NULL REFERENCES auth.users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          bigint NOT NULL REFERENCES auth.users (id),
  row_version         integer NOT NULL DEFAULT 1,
  CONSTRAINT suppliers_trn_ck CHECK (is_vat_registered = (trn IS NOT NULL))
);
CREATE UNIQUE INDEX suppliers_code_uq ON md.suppliers (lower(code));
CREATE UNIQUE INDEX suppliers_trn_uq ON md.suppliers (trn);
CREATE INDEX suppliers_search_ix ON md.suppliers USING gin (search_key gin_trgm_ops);

CREATE FUNCTION md.supplier_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_code text;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.code IS NULL THEN
    LOOP
      v_code := 'S' || lpad(nextval('md.supplier_code_seq')::text, 5, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM md.suppliers WHERE lower(code) = lower(v_code));
    END LOOP;
    NEW.code := v_code;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'The code of a supplier never changes' USING ERRCODE = 'AP011', HINT = 'CODE_FIXED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_supplier_rules BEFORE INSERT OR UPDATE ON md.suppliers
  FOR EACH ROW EXECUTE FUNCTION md.supplier_rules();
SELECT sys.add_touch('md.suppliers');
SELECT sys.add_deactivation_reason('md.suppliers');
SELECT audit.enable_for('md.suppliers', p_ignored => ARRAY['search_key']);
SELECT sys.forbid_delete('md.suppliers');

-- ---------------------------------------------------------------------------------------------
-- Technicians (no sign-in needed; optionally linked to a user)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE md.technicians (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name_ar      text NOT NULL CHECK (btrim(name_ar) <> ''),
  name_en      text NOT NULL CHECK (btrim(name_en) <> ''),
  phone        text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  user_id      bigint UNIQUE REFERENCES auth.users (id),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint NOT NULL REFERENCES auth.users (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint NOT NULL REFERENCES auth.users (id),
  row_version  integer NOT NULL DEFAULT 1,
  CONSTRAINT technicians_not_system_ck CHECK (user_id <> 1)
);
CREATE UNIQUE INDEX technicians_code_uq ON md.technicians (lower(code));
SELECT sys.add_touch('md.technicians');
SELECT sys.add_deactivation_reason('md.technicians');
SELECT audit.enable_for('md.technicians');
SELECT sys.forbid_delete('md.technicians');

-- ---------------------------------------------------------------------------------------------
-- Payment methods
-- ---------------------------------------------------------------------------------------------
CREATE TABLE md.payment_methods (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name_ar             text NOT NULL CHECK (btrim(name_ar) <> ''),
  name_en             text NOT NULL CHECK (btrim(name_en) <> ''),
  kind                text NOT NULL CHECK (kind IN ('cash', 'card', 'bank_transfer', 'cheque', 'other')),
  gl_account_id       bigint NOT NULL REFERENCES gl.accounts (id),
  opens_drawer        boolean NOT NULL DEFAULT false,
  gives_change        boolean NOT NULL DEFAULT false,
  requires_reference  boolean NOT NULL DEFAULT false,
  in_pos              boolean NOT NULL DEFAULT true,
  in_office           boolean NOT NULL DEFAULT true,
  sort_order          integer NOT NULL DEFAULT 0,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          bigint NOT NULL REFERENCES auth.users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          bigint NOT NULL REFERENCES auth.users (id),
  row_version         integer NOT NULL DEFAULT 1,
  CONSTRAINT payment_methods_change_ck CHECK (NOT gives_change OR kind = 'cash'),
  CONSTRAINT payment_methods_where_ck CHECK (in_pos OR in_office)
);
CREATE UNIQUE INDEX payment_methods_code_uq ON md.payment_methods (lower(code));

CREATE FUNCTION md.payment_method_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.code, NEW.kind) IS DISTINCT FROM (OLD.code, OLD.kind) THEN
    RAISE EXCEPTION 'The code and kind of a payment method never change' USING ERRCODE = 'AP011', HINT = 'CODE_FIXED';
  END IF;
  IF NEW.is_active THEN
    PERFORM gl.assert_plain_account(NEW.gl_account_id, ARRAY['asset'], 'PAYMENT_ACCOUNT_INVALID');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_payment_method_rules BEFORE INSERT OR UPDATE ON md.payment_methods
  FOR EACH ROW EXECUTE FUNCTION md.payment_method_rules();
SELECT sys.add_touch('md.payment_methods');
SELECT sys.add_deactivation_reason('md.payment_methods');
SELECT audit.enable_for('md.payment_methods');
SELECT sys.forbid_delete('md.payment_methods');

INSERT INTO md.payment_methods (code, name_ar, name_en, kind, gl_account_id, opens_drawer, gives_change,
                                requires_reference, in_pos, in_office, sort_order)
SELECT p.code, p.name_ar, p.name_en, p.kind, a.id, p.opens_drawer, p.gives_change, p.requires_reference,
       p.in_pos, p.in_office, p.sort_order
  FROM (VALUES ('CASH', 'نقدًا', 'Cash', 'cash', '1110', true, true, false, true, true, 1),
               ('CARD', 'بطاقة', 'Card', 'card', '1150', false, false, false, true, true, 2),
               ('BANK', 'تحويل بنكي', 'Bank transfer', 'bank_transfer', '1140', false, false, true, false, true, 3),
               ('CHEQUE', 'شيك', 'Cheque', 'cheque', '1160', false, false, true, false, true, 4))
       AS p(code, name_ar, name_en, kind, account, opens_drawer, gives_change, requires_reference,
            in_pos, in_office, sort_order)
  JOIN gl.accounts AS a ON a.code = p.account;

-- ---------------------------------------------------------------------------------------------
-- Warehouses (one now; every stock movement will carry one). Exactly one default per branch.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE md.warehouses (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name_ar         text NOT NULL CHECK (btrim(name_ar) <> ''),
  name_en         text NOT NULL CHECK (btrim(name_en) <> ''),
  branch_id       bigint NOT NULL REFERENCES sys.branches (id),
  warehouse_type  text NOT NULL CHECK (warehouse_type IN ('store', 'van', 'site')),
  technician_id   bigint REFERENCES md.technicians (id),
  is_default      boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      bigint NOT NULL REFERENCES auth.users (id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      bigint NOT NULL REFERENCES auth.users (id),
  row_version     integer NOT NULL DEFAULT 1,
  CONSTRAINT warehouses_van_ck CHECK (warehouse_type <> 'van' OR technician_id IS NOT NULL),
  CONSTRAINT warehouses_default_ck CHECK (NOT is_default OR is_active)
);
CREATE UNIQUE INDEX warehouses_code_uq ON md.warehouses (lower(code));
CREATE UNIQUE INDEX warehouses_default_uq ON md.warehouses (branch_id) WHERE is_default;

-- Making a warehouse the default takes the mark from the branch's previous default; the mark can
-- never simply be removed.
CREATE FUNCTION md.warehouse_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'The code of a warehouse never changes' USING ERRCODE = 'AP011', HINT = 'CODE_FIXED';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_default AND NOT NEW.is_default
     AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'Choose another default warehouse instead' USING ERRCODE = 'AP011', HINT = 'DEFAULT_REQUIRED';
  END IF;
  IF NEW.is_default AND (TG_OP = 'INSERT' OR NOT OLD.is_default) THEN
    UPDATE md.warehouses SET is_default = false
     WHERE branch_id = NEW.branch_id AND is_default AND id IS DISTINCT FROM NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_warehouse_rules BEFORE INSERT OR UPDATE ON md.warehouses
  FOR EACH ROW EXECUTE FUNCTION md.warehouse_rules();
SELECT sys.add_touch('md.warehouses');
SELECT sys.add_deactivation_reason('md.warehouses');
SELECT audit.enable_for('md.warehouses');
SELECT sys.forbid_delete('md.warehouses');

INSERT INTO md.warehouses (code, name_ar, name_en, branch_id, warehouse_type, is_default)
SELECT 'MAIN', 'المخزن الرئيسي – العين', 'Main warehouse – Al Ain', id, 'store', true
  FROM sys.branches WHERE code = 'HQ';

-- ---------------------------------------------------------------------------------------------
-- Cash denominations (used by shift counts in M5)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE md.cash_denominations (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  value_fils   bigint NOT NULL UNIQUE CHECK (value_fils > 0),
  kind         text NOT NULL CHECK (kind IN ('note', 'coin')),
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint NOT NULL REFERENCES auth.users (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint NOT NULL REFERENCES auth.users (id),
  row_version  integer NOT NULL DEFAULT 1
);
SELECT sys.add_touch('md.cash_denominations');
SELECT audit.enable_for('md.cash_denominations');
SELECT sys.forbid_delete('md.cash_denominations');

INSERT INTO md.cash_denominations (value_fils, kind, sort_order) VALUES
  (100000, 'note', 1), (50000, 'note', 2), (20000, 'note', 3), (10000, 'note', 4),
  (5000, 'note', 5), (2000, 'note', 6), (1000, 'note', 7), (500, 'note', 8),
  (100, 'coin', 9), (50, 'coin', 10), (25, 'coin', 11);

-- ---------------------------------------------------------------------------------------------
-- Reason codes. Paid-in and paid-out reasons carry the account they post to (posting map 16–17).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sys.reason_codes (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category       text NOT NULL CHECK (category IN (
                   'stock_increase', 'stock_decrease', 'stock_count', 'defective', 'write_off', 'oversell',
                   'credit_note', 'debit_note', 'payment_reversal', 'price_override', 'discount_override',
                   'no_sale', 'paid_in', 'paid_out', 'cash_recount', 'cash_variance', 'draft_discard',
                   'reprint', 'other')),
  code           text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name_ar        text NOT NULL CHECK (btrim(name_ar) <> ''),
  name_en        text NOT NULL CHECK (btrim(name_en) <> ''),
  requires_note  boolean NOT NULL DEFAULT false,
  gl_account_id  bigint REFERENCES gl.accounts (id),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     bigint NOT NULL REFERENCES auth.users (id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint NOT NULL REFERENCES auth.users (id),
  row_version    integer NOT NULL DEFAULT 1,
  CONSTRAINT reason_codes_account_ck CHECK ((category IN ('paid_in', 'paid_out')) = (gl_account_id IS NOT NULL))
);
CREATE UNIQUE INDEX reason_codes_code_uq ON sys.reason_codes (category, lower(code));

CREATE FUNCTION sys.reason_code_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.category, NEW.code) IS DISTINCT FROM (OLD.category, OLD.code) THEN
    RAISE EXCEPTION 'The category and code of a reason never change' USING ERRCODE = 'AP011', HINT = 'CODE_FIXED';
  END IF;
  IF NEW.gl_account_id IS NOT NULL AND NEW.is_active THEN
    PERFORM gl.assert_plain_account(NEW.gl_account_id, ARRAY['asset', 'liability', 'equity', 'revenue', 'expense'],
                                    'REASON_ACCOUNT_INVALID');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_reason_code_rules BEFORE INSERT OR UPDATE ON sys.reason_codes
  FOR EACH ROW EXECUTE FUNCTION sys.reason_code_rules();
SELECT sys.add_touch('sys.reason_codes');
SELECT sys.add_deactivation_reason('sys.reason_codes');
SELECT audit.enable_for('sys.reason_codes');
SELECT sys.forbid_delete('sys.reason_codes');

INSERT INTO sys.reason_codes (category, code, name_ar, name_en, requires_note, gl_account_id)
SELECT r.category, r.code, r.name_ar, r.name_en, r.requires_note, a.id
  FROM (VALUES
    ('stock_decrease', 'DAMAGED', 'تالف', 'Damaged', false, NULL),
    ('stock_decrease', 'EXPIRED', 'منتهي الصلاحية', 'Expired', false, NULL),
    ('stock_decrease', 'THEFT', 'سرقة أو فقدان', 'Theft or loss', true, NULL),
    ('stock_decrease', 'CORRECTION', 'تصحيح بيانات', 'Data correction', true, NULL),
    ('stock_increase', 'FOUND', 'وُجد في الجرد', 'Found', false, NULL),
    ('stock_increase', 'CORRECTION', 'تصحيح بيانات', 'Data correction', true, NULL),
    ('oversell', 'OVERSELL', 'بيع بدون رصيد', 'Sold without stock', false, NULL),
    ('defective', 'BROKEN', 'مرتجع تالف من العميل', 'Customer return – broken', false, NULL),
    ('credit_note', 'RETURN', 'إرجاع بضاعة', 'Goods returned', false, NULL),
    ('credit_note', 'PRICE_ADJ', 'تعديل سعر', 'Price adjustment', true, NULL),
    ('credit_note', 'INV_ERROR', 'خطأ في الفاتورة', 'Invoice error', true, NULL),
    ('credit_note', 'WRONG_FORMAT', 'نوع فاتورة خاطئ', 'Wrong invoice format', false, NULL),
    ('payment_reversal', 'BOUNCED', 'شيك مرتجع', 'Bounced cheque', false, NULL),
    ('paid_in', 'CHANGE_FLOAT', 'إضافة فكة', 'Change float', false, '1120'),
    ('paid_out', 'PETTY', 'مصروف نثري', 'Petty expense', true, '6900'),
    ('paid_out', 'OWNER', 'سحب المالك', 'Owner withdrawal', false, '3200'),
    ('paid_out', 'BANK_DEPOSIT', 'إيداع في البنك', 'Bank deposit', false, '1140'),
    ('no_sale', 'GIVE_CHANGE', 'فك عملة', 'Give change', false, NULL),
    ('no_sale', 'CHECK_DRAWER', 'فحص الدرج', 'Check the drawer', false, NULL),
    ('cash_recount', 'MISCOUNT', 'خطأ في العد', 'Miscount', false, NULL),
    ('reprint', 'CUSTOMER', 'طلب العميل', 'Customer request', false, NULL))
       AS r(category, code, name_ar, name_en, requires_note, account)
  LEFT JOIN gl.accounts AS a ON a.code = r.account;

-- ---------------------------------------------------------------------------------------------
-- More reasons an account is in use (replaces the 0008 version; 0011 adds postings)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gl.account_in_use(p_account_id bigint) RETURNS text
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM gl.account_mappings WHERE account_id = p_account_id) THEN
    RETURN 'event_link';
  END IF;
  IF EXISTS (SELECT 1 FROM md.business_lines
              WHERE p_account_id IN (revenue_account_id, cogs_account_id) AND is_active) THEN
    RETURN 'business_line';
  END IF;
  IF EXISTS (SELECT 1 FROM md.payment_methods WHERE gl_account_id = p_account_id AND is_active) THEN
    RETURN 'payment_method';
  END IF;
  IF EXISTS (SELECT 1 FROM sys.reason_codes WHERE gl_account_id = p_account_id AND is_active) THEN
    RETURN 'reason_code';
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Company details: TRN starts with 100; logo PNG or JPEG only (decision 0037)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE sys.company_profile DROP CONSTRAINT company_profile_logo_mime_check;
ALTER TABLE sys.company_profile
  ADD CONSTRAINT company_logo_mime_ck CHECK (logo_mime IN ('image/png', 'image/jpeg')),
  ADD CONSTRAINT company_trn_format_ck CHECK (trn ~ '^100[0-9]{12}$');

-- ---------------------------------------------------------------------------------------------
-- Numbering series: the prefix, width and start number may change until the first number is
-- used (decision 0011: defaults approved, changeable before go-live). Replaces the 0004 guard.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sys.guard_series() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.doc_type, NEW.channel, NEW.branch_id, NEW.code)
     IS DISTINCT FROM (OLD.doc_type, OLD.channel, OLD.branch_id, OLD.code) THEN
    RAISE EXCEPTION 'A numbering series cannot be changed once created; create a new series instead'
      USING ERRCODE = 'AP003';
  END IF;
  IF (NEW.prefix, NEW.number_width, NEW.start_number)
     IS DISTINCT FROM (OLD.prefix, OLD.number_width, OLD.start_number) THEN
    IF OLD.next_number <> OLD.start_number OR NEW.next_number <> OLD.next_number THEN
      RAISE EXCEPTION 'Series % has issued numbers, so its prefix, width and start cannot change', OLD.code
        USING ERRCODE = 'AP011', HINT = 'SERIES_IN_USE';
    END IF;
    NEW.next_number := NEW.start_number;
    RETURN NEW;
  END IF;
  IF NEW.next_number <> OLD.next_number AND NEW.next_number <> OLD.next_number + 1 THEN
    RAISE EXCEPTION 'Document numbers can only advance one at a time (% → %)', OLD.next_number, NEW.next_number
      USING ERRCODE = 'AP005';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------
-- The links M1 left open
-- ---------------------------------------------------------------------------------------------
ALTER TABLE auth.devices
  ADD CONSTRAINT devices_default_warehouse_fk FOREIGN KEY (default_warehouse_id) REFERENCES md.warehouses (id);
ALTER TABLE auth.approvals
  ADD CONSTRAINT approvals_reason_code_fk FOREIGN KEY (reason_code_id) REFERENCES sys.reason_codes (id);

-- ---------------------------------------------------------------------------------------------
-- Permission: giving customers credit (decision 0036), for the owner and accountant roles
-- ---------------------------------------------------------------------------------------------
INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable)
VALUES ('customers.credit', 'masterdata', 'منح العملاء آجلًا', 'Give customers credit', true, false);
INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT id, 'customers.credit' FROM auth.roles WHERE code IN ('owner', 'accountant');

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION gl.assert_plain_account(bigint, text[], text),
  md.assert_unit_decimals(numeric, bigint), md.item_in_use(bigint) TO artepool_api;

GRANT SELECT ON md.units, md.vat_categories, md.business_lines, md.item_categories, md.items,
  md.item_barcodes, md.bundle_components, md.price_levels, md.item_prices, md.customers, md.suppliers,
  md.technicians, md.payment_methods, md.warehouses, md.cash_denominations, sys.reason_codes
  TO artepool_api;

GRANT INSERT (code, name_ar, name_en, decimals, einvoice_code, is_active) ON md.units TO artepool_api;
GRANT UPDATE (name_ar, name_en, decimals, einvoice_code, is_active) ON md.units TO artepool_api;

GRANT UPDATE (rate_bp) ON md.vat_categories TO artepool_api;

GRANT INSERT (code, name_ar, name_en, revenue_account_id, cogs_account_id, sort_order, is_active)
  ON md.business_lines TO artepool_api;
GRANT UPDATE (name_ar, name_en, revenue_account_id, cogs_account_id, sort_order, is_active)
  ON md.business_lines TO artepool_api;

GRANT INSERT (parent_id, code, name_ar, name_en, sort_order, is_active) ON md.item_categories TO artepool_api;
GRANT UPDATE (parent_id, code, name_ar, name_en, sort_order, is_active) ON md.item_categories TO artepool_api;

GRANT INSERT (code, item_type, name_ar, name_en, description_ar, description_en, category_id, unit_id,
              vat_category_id, default_business_line_id, reorder_level, reorder_qty, fallback_unit_cost_4dp,
              is_sellable, is_active)
  ON md.items TO artepool_api;
GRANT UPDATE (item_type, name_ar, name_en, description_ar, description_en, category_id, unit_id,
              vat_category_id, default_business_line_id, reorder_level, reorder_qty, fallback_unit_cost_4dp,
              is_sellable, is_active)
  ON md.items TO artepool_api;

GRANT INSERT (item_id, barcode, qty_per_scan, is_primary, is_active) ON md.item_barcodes TO artepool_api;
GRANT UPDATE (qty_per_scan, is_primary, is_active) ON md.item_barcodes TO artepool_api;

GRANT INSERT (bundle_item_id, component_item_id, quantity) ON md.bundle_components TO artepool_api;
GRANT UPDATE (quantity) ON md.bundle_components TO artepool_api;
GRANT DELETE ON md.bundle_components TO artepool_api;

GRANT INSERT (price_level_id, item_id, price_4dp, includes_vat) ON md.item_prices TO artepool_api;
GRANT UPDATE (price_4dp, includes_vat) ON md.item_prices TO artepool_api;

GRANT INSERT (code, customer_type, name, name_alt, is_vat_registered, trn, phone, phone_alt, email,
              address_line, area, city, po_box, emirate, country_code, credit_mode, payment_terms_days,
              credit_limit_fils, preferred_language, notes, is_active)
  ON md.customers TO artepool_api;
GRANT UPDATE (customer_type, name, name_alt, is_vat_registered, trn, phone, phone_alt, email,
              address_line, area, city, po_box, emirate, country_code, credit_mode, payment_terms_days,
              credit_limit_fils, preferred_language, notes, is_active)
  ON md.customers TO artepool_api;
GRANT USAGE ON SEQUENCE md.customer_code_seq, md.supplier_code_seq TO artepool_api;

GRANT INSERT (code, name, name_alt, is_vat_registered, trn, phone, email, address_line, city, emirate,
              country_code, payment_terms_days, notes, is_active)
  ON md.suppliers TO artepool_api;
GRANT UPDATE (name, name_alt, is_vat_registered, trn, phone, email, address_line, city, emirate,
              country_code, payment_terms_days, notes, is_active)
  ON md.suppliers TO artepool_api;

GRANT INSERT (code, name_ar, name_en, phone, user_id, is_active) ON md.technicians TO artepool_api;
GRANT UPDATE (code, name_ar, name_en, phone, user_id, is_active) ON md.technicians TO artepool_api;

GRANT INSERT (code, name_ar, name_en, kind, gl_account_id, opens_drawer, gives_change, requires_reference,
              in_pos, in_office, sort_order, is_active)
  ON md.payment_methods TO artepool_api;
GRANT UPDATE (name_ar, name_en, gl_account_id, opens_drawer, gives_change, requires_reference, in_pos,
              in_office, sort_order, is_active)
  ON md.payment_methods TO artepool_api;

GRANT INSERT (code, name_ar, name_en, branch_id, warehouse_type, technician_id, is_default, is_active)
  ON md.warehouses TO artepool_api;
GRANT UPDATE (name_ar, name_en, warehouse_type, technician_id, is_default, is_active)
  ON md.warehouses TO artepool_api;

GRANT INSERT (category, code, name_ar, name_en, requires_note, gl_account_id, is_active)
  ON sys.reason_codes TO artepool_api;
GRANT UPDATE (name_ar, name_en, requires_note, gl_account_id, is_active) ON sys.reason_codes TO artepool_api;

GRANT UPDATE (default_warehouse_id) ON auth.devices TO artepool_api;
GRANT UPDATE (prefix, number_width, start_number) ON sys.document_series TO artepool_api;
