-- 0041_label_prints.sql
-- Purpose: decision 0099. Every barcode label print is recorded, one row per item: the price on the
-- label (the 4-decimal sale price, "price includes VAT", the VAT rate and the price with VAT), the
-- number of labels, the size, the design version, who printed and on which PC. The "price changed,
-- label is old" list compares each item's last printed label with its price today. A row is
-- refused when the printed price is no longer the item's price (it changed while printing).
-- Rows are audited and never changed or deleted.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0041: label print record (decision 0099)');

CREATE TABLE inv.label_prints (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id            bigint NOT NULL REFERENCES md.items (id),
  label_size_id      bigint NOT NULL REFERENCES md.label_sizes (id),
  design_version_id  bigint NOT NULL REFERENCES sys.print_template_versions (id),
  copies             integer NOT NULL CHECK (copies BETWEEN 1 AND 10000),
  -- How the labels were chosen: one item's labels window, a hand-made list, the "price changed"
  -- list, or a stock document (stock increase, opening stock).
  source             text NOT NULL CHECK (source IN ('item', 'list', 'price_changed', 'stock_document')),
  -- The price on the label; all four empty when the label had no price.
  price_4dp          bigint CHECK (price_4dp >= 0),
  includes_vat       boolean,
  vat_rate_bp        integer CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  gross_fils         bigint CHECK (gross_fils >= 0),
  device_id          bigint REFERENCES auth.devices (id) DEFAULT sys.ctx_device_id(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         bigint NOT NULL REFERENCES auth.users (id),
  CONSTRAINT label_prints_price_ck CHECK (
    (price_4dp IS NULL) = (includes_vat IS NULL)
    AND (price_4dp IS NULL) = (vat_rate_bp IS NULL)
    AND (price_4dp IS NULL) = (gross_fils IS NULL))
);
CREATE INDEX label_prints_item_idx ON inv.label_prints (item_id, id DESC);
COMMENT ON TABLE inv.label_prints IS
  'Every barcode label print, per item, with the price on the label (decision 0099). Never changed or deleted.';

-- The price on the label must be the item's price now: its standard sale price, "price includes
-- VAT" and the rate of its VAT category. Otherwise the price changed while printing: refused. (A
-- price saved at the very same moment leaves the item on the "price changed" list: the safe side.)
CREATE FUNCTION inv.label_print_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_price bigint;
  v_includes boolean;
  v_rate integer;
BEGIN
  IF NEW.price_4dp IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT v.rate_bp INTO v_rate
    FROM md.items i JOIN md.vat_categories v ON v.id = i.vat_category_id
   WHERE i.id = NEW.item_id;
  SELECT p.price_4dp, p.includes_vat INTO v_price, v_includes
    FROM md.item_prices p JOIN md.price_levels l ON l.id = p.price_level_id AND l.is_default
   WHERE p.item_id = NEW.item_id;
  IF v_price IS DISTINCT FROM NEW.price_4dp OR v_includes IS DISTINCT FROM NEW.includes_vat
     OR v_rate IS DISTINCT FROM NEW.vat_rate_bp THEN
    RAISE EXCEPTION 'The price changed while the labels were printed'
      USING ERRCODE = 'AP011', HINT = 'LABEL_PRICE_CHANGED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_label_print_rules BEFORE INSERT ON inv.label_prints
  FOR EACH ROW EXECUTE FUNCTION inv.label_print_rules();
SELECT sys.add_stamp('inv.label_prints');
SELECT audit.enable_for('inv.label_prints');
SELECT sys.forbid_delete('inv.label_prints');
SELECT sys.add_immutable_guard('inv.label_prints', '', '', '');

GRANT SELECT ON inv.label_prints TO artepool_api;
GRANT INSERT (item_id, label_size_id, design_version_id, copies, source, price_4dp, includes_vat,
              vat_rate_bp, gross_fils) ON inv.label_prints TO artepool_api;
