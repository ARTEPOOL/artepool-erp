-- 0013 — Inventory hardening (found in the M3 code review)
--
-- 1. A movement may only belong to a document that is still open (a draft adjustment, a count
--    being counted), to the item of its line, in the document's warehouse, and only as many
--    times as the line allows. Stock can no longer change after a document is posted.
-- 2. The values the approval threshold is compared with (decision 0041) are calculated here
--    from the movements, never taken from the request.
-- 3. Opening stock is posted once per item and warehouse (decision 0042).
-- 4. inv.lock_balances: the API reads and locks the current balances before it posts a count,
--    so a sale committing at the same moment can neither be counted twice nor be missed.

-- 1 -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inv.apply_movement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  b inv.balances%ROWTYPE;
  v_after bigint;
  v_doc record;
  v_used integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM md.items WHERE id = NEW.item_id AND item_type = 'stock') THEN
    RAISE EXCEPTION 'Only stock items have stock' USING ERRCODE = 'AP011', HINT = 'STOCK_ITEM_ONLY';
  END IF;

  -- The document the movement belongs to must still be open, and match it.
  IF NEW.adjustment_line_id IS NOT NULL THEN
    SELECT a.status, a.kind, a.warehouse_id, l.item_id INTO v_doc
      FROM inv.adjustment_lines l JOIN inv.adjustments a ON a.id = l.adjustment_id
     WHERE l.id = NEW.adjustment_line_id
       FOR SHARE OF a;
    -- A move to defective has two movements per line (out of one status, into the other).
    SELECT count(*) - (CASE WHEN v_doc.kind = 'status_change' THEN 2 ELSE 1 END)
      INTO v_used FROM inv.movements WHERE adjustment_line_id = NEW.adjustment_line_id;
    IF v_doc.status IS DISTINCT FROM 'draft' OR v_doc.item_id <> NEW.item_id
       OR v_doc.warehouse_id <> NEW.warehouse_id OR v_used >= 0 THEN
      RAISE EXCEPTION 'This movement does not fit an open adjustment line'
        USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
    END IF;
  END IF;
  IF NEW.count_line_id IS NOT NULL THEN
    SELECT c.status, c.warehouse_id, l.item_id, l.stock_status INTO v_doc
      FROM inv.count_lines l JOIN inv.counts c ON c.id = l.count_id
     WHERE l.id = NEW.count_line_id
       FOR SHARE OF c;
    IF v_doc.status IS DISTINCT FROM 'counting' OR v_doc.item_id <> NEW.item_id
       OR v_doc.warehouse_id <> NEW.warehouse_id OR v_doc.stock_status <> NEW.stock_status
       OR EXISTS (SELECT 1 FROM inv.movements WHERE count_line_id = NEW.count_line_id) THEN
      RAISE EXCEPTION 'This movement does not fit an open count line'
        USING ERRCODE = 'AP011', HINT = 'DOCUMENT_STEP';
    END IF;
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

-- 2 and 3 -------------------------------------------------------------------------------------
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
      IF NOT auth.user_has_permission(sys.require_user(), 'stock.opening') THEN
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

CREATE OR REPLACE FUNCTION inv.count_rules() RETURNS trigger
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
      -- The differences' values come from the movements, never from the request.
      SELECT coalesce(sum(m.value_fils), 0), coalesce(sum(abs(m.value_fils)), 0)
        INTO NEW.total_value_fils, NEW.variance_abs_fils
        FROM inv.movements m JOIN inv.count_lines l ON l.id = m.count_line_id
       WHERE l.count_id = NEW.id;
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

-- 4 -------------------------------------------------------------------------------------------
-- Locks the balances of these items (in item order, so two callers never deadlock each other)
-- and returns their current quantities. Items without a balance yet get an empty one first.
CREATE FUNCTION inv.lock_balances(p_warehouse_id bigint, p_stock_status text, p_item_ids bigint[])
RETURNS TABLE (item_id bigint, quantity numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
BEGIN
  INSERT INTO inv.balances (item_id, warehouse_id, stock_status)
  SELECT i, p_warehouse_id, p_stock_status FROM unnest(p_item_ids) AS i ORDER BY i
  ON CONFLICT DO NOTHING;
  RETURN QUERY
    SELECT b.item_id, b.quantity FROM inv.balances b
     WHERE b.warehouse_id = p_warehouse_id AND b.stock_status = p_stock_status
       AND b.item_id = ANY (p_item_ids)
     ORDER BY b.item_id
       FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION inv.lock_balances(bigint, text, bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inv.lock_balances(bigint, text, bigint[]) TO artepool_api;
