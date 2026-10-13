-- Decision 0053: the quantity on hand of a NEW stock item may be entered when the item is created,
-- by the owner, the accountant or the storekeeper (permission stock.new_item_quantity). It is posted
-- as that item's opening stock (once per item, decision 0042); opening stock for existing items stays
-- owner only (stock.opening).

SELECT sys.set_context(1, p_reason => 'migration 0019: a new item''s quantity (decision 0053)');

INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('stock.new_item_quantity', 'inventory', 'إدخال كمية الصنف الجديد', 'Enter a new item''s quantity',
        false, false, false);
INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT id, 'stock.new_item_quantity' FROM auth.roles WHERE code IN ('owner', 'accountant', 'storekeeper');

CREATE OR REPLACE FUNCTION inv.adjustment_rules() RETURNS trigger
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
    IF NEW.kind = 'opening' THEN
      -- Decision 0053: the quantity of a new item, entered when the item is created (the item
      -- was made in this same transaction), by anyone with stock.new_item_quantity.
      IF NOT auth.user_has_permission(sys.require_user(), 'stock.opening')
         AND NOT (auth.user_has_permission(sys.require_user(), 'stock.new_item_quantity')
                  AND NOT EXISTS (SELECT 1 FROM inv.adjustment_lines l JOIN md.items i ON i.id = l.item_id
                                   WHERE l.adjustment_id = NEW.id AND i.created_at <> now())) THEN
        RAISE EXCEPTION 'Only the owner posts opening stock' USING ERRCODE = 'AP012', HINT = 'OPENING_OWNER_ONLY';
      END IF;
      -- Decision 0042: once per item and warehouse; later changes are adjustments.
      IF EXISTS (SELECT 1
                   FROM inv.adjustment_lines l
                   JOIN inv.adjustment_lines p ON p.item_id = l.item_id
                   JOIN inv.adjustments pa ON pa.id = p.adjustment_id
                  WHERE l.adjustment_id = NEW.id AND pa.id <> NEW.id AND pa.kind = 'opening'
                    AND pa.status = 'posted' AND pa.warehouse_id = NEW.warehouse_id) THEN
        RAISE EXCEPTION 'Opening stock is already posted for an item of this document'
          USING ERRCODE = 'AP011', HINT = 'OPENING_ALREADY_POSTED';
      END IF;
    END IF;
    -- The document's value comes from its movements, never from the request
    -- (for a move to defective: the value that arrived in the new status).
    SELECT coalesce(sum(m.value_fils) FILTER (WHERE NEW.kind <> 'status_change' OR m.quantity > 0), 0)
      INTO NEW.total_value_fils
      FROM inv.movements m JOIN inv.adjustment_lines l ON l.id = m.adjustment_line_id
     WHERE l.adjustment_id = NEW.id;
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
