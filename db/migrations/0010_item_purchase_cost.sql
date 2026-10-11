-- 0010_item_purchase_cost.sql
-- Purpose: the item's purchase price (decision 0038). It is the item's starting cost, without VAT
-- (input VAT is recoverable), in 4 decimals, and only the owner may see or change it (permission
-- `items.cost`, owner-only). Until purchases and stock movements give a real weighted-average cost
-- (M3 / Phase 2), sales and reports value the cost of goods sold from this price, copied onto each
-- sale when it happens. A kit has no cost of its own: it is the sum of its components.
-- The column already exists (md.items.fallback_unit_cost_4dp, migration 0009) and is already
-- granted; this migration lets services have a cost too, keeps kits without one, and puts the
-- permission rule in the database.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0010: item purchase cost (decision 0038)');

COMMENT ON COLUMN md.items.fallback_unit_cost_4dp IS
  'Purchase price per unit, 4 decimals (AED x 10,000), without VAT. Owner only (items.cost). '
  'Stock items and services; a kit''s cost is the sum of its components.';

ALTER TABLE md.items DROP CONSTRAINT items_stock_fields_ck;
ALTER TABLE md.items ADD CONSTRAINT items_stock_fields_ck CHECK (
  (item_type = 'stock' OR (reorder_level IS NULL AND reorder_qty IS NULL))
  AND (item_type <> 'bundle' OR fallback_unit_cost_4dp IS NULL));

-- Setting or changing the cost needs `items.cost`.
CREATE FUNCTION md.item_cost_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.fallback_unit_cost_4dp IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.fallback_unit_cost_4dp IS DISTINCT FROM OLD.fallback_unit_cost_4dp) THEN
    IF NOT auth.user_has_permission(sys.require_user(), 'items.cost') THEN
      RAISE EXCEPTION 'Changing an item''s purchase price needs the items.cost permission'
        USING ERRCODE = 'AP012', HINT = 'COST_PERMISSION';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c_item_cost_rules BEFORE INSERT OR UPDATE ON md.items
  FOR EACH ROW EXECUTE FUNCTION md.item_cost_rules();

-- The permission: owner only (the database refuses to give an owner-only permission to any other role).
INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('items.cost', 'masterdata', 'عرض وتعديل سعر الشراء', 'See and change purchase prices',
        true, false, true);
INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT id, 'items.cost' FROM auth.roles WHERE code = 'owner';
