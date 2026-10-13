-- Fixes from the M4 screens review.
--  1. A supervisor's approval is for one thing: a price approval no longer also waives the
--     discount limit (invoices and quotations). Quotations get their own price approval column.
--  2. A credit or debit note line follows its original invoice line (price basis, VAT), not the
--     item's current price, so a later price change cannot block or change a note.
--  3. An issued document with nothing left to pay is "settled", also at 0.00 (a final invoice fully
--     covered by its earlier payments), so it is never offered as an open debt.

ALTER TABLE sales.quotations ADD COLUMN price_approval_id bigint REFERENCES auth.approvals (id);
GRANT UPDATE (price_approval_id) ON sales.quotations TO artepool_api;

CREATE OR REPLACE FUNCTION sales.document_rules() RETURNS trigger
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
    -- Only a discount approval waives the limit: a price approval covers prices only.
    IF NEW.discount_total_fils > 0 AND NEW.doc_type = 'invoice'
       AND NOT EXISTS (SELECT 1 FROM auth.approvals WHERE id = NEW.approval_id
                         AND permission_code = 'sales.discount_over_limit')
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
  -- An issued document with nothing left to pay is settled, even at 0.00 (a final invoice fully
  -- covered by its earlier payments, decision 0013).
  NEW.settlement_status := CASE WHEN NEW.settled_fils >= NEW.total_fils
                                 AND (NEW.total_fils > 0 OR NEW.status = 'issued') THEN 'settled'
                                WHEN NEW.settled_fils = 0 THEN 'open' ELSE 'partial' END;
  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION sales.quotation_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_number record;
  t record;
  v_user bigint;
  v_limit record;
  v_before bigint;
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
      -- The prices promised are approved when the quotation is sent; converting keeps them (0049).
      v_user := sys.require_user();
      -- Two separate approvals: one for changed prices, one for a discount above the limit.
      IF NEW.approval_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.approvals WHERE id = NEW.approval_id
           AND permission_code = 'sales.discount_over_limit') THEN
        RAISE EXCEPTION 'This approval is for something else' USING ERRCODE = 'AP012', HINT = 'APPROVAL_INVALID';
      END IF;
      IF NEW.price_approval_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.approvals
           WHERE id = NEW.price_approval_id AND permission_code = 'sales.price_override') THEN
        RAISE EXCEPTION 'This approval is for something else' USING ERRCODE = 'AP012', HINT = 'APPROVAL_INVALID';
      END IF;
      IF NEW.price_approval_id IS NULL AND NOT auth.user_has_permission(v_user, 'sales.price_override')
         AND EXISTS (SELECT 1 FROM sales.quotation_lines WHERE quotation_id = NEW.id AND unit_price_4dp <> list_price_4dp) THEN
        RAISE EXCEPTION 'A changed price needs approval' USING ERRCODE = 'AP012', HINT = 'PRICE_OVERRIDE';
      END IF;
      IF NEW.approval_id IS NULL AND NEW.discount_total_fils > 0
         AND NOT auth.user_has_permission(v_user, 'sales.discount_over_limit') THEN
        SELECT coalesce(sum(amount_before_discount_fils), 0) INTO v_before
          FROM sales.quotation_lines WHERE quotation_id = NEW.id AND NOT is_optional;
        SELECT * INTO v_limit FROM sales.discount_limit(v_user);
        IF NEW.discount_total_fils > v_limit.max_fils
           OR NEW.discount_total_fils * 10000 > v_limit.max_bp::bigint * v_before THEN
          RAISE EXCEPTION 'This discount is above your limit' USING ERRCODE = 'AP012', HINT = 'DISCOUNT_OVER_LIMIT';
        END IF;
      END IF;
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

CREATE OR REPLACE FUNCTION sales.compute_item_line() RETURNS trigger
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
  IF TG_TABLE_NAME = 'document_lines' THEN
    IF NEW.quotation_line_id IS NOT NULL THEN
      -- A line converted from a quotation keeps the agreed price (decision 0049).
      SELECT ql.unit_price_4dp INTO NEW.list_price_4dp
        FROM sales.quotation_lines ql
        JOIN sales.documents d ON d.quotation_id = ql.quotation_id AND d.id = NEW.document_id
       WHERE ql.id = NEW.quotation_line_id AND ql.item_id = NEW.item_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'This line is not on the document''s quotation' USING ERRCODE = 'AP011', HINT = 'QUOTATION_LINE';
      END IF;
    END IF;
  END IF;
  SELECT vat_category_id INTO NEW.vat_category_id FROM md.items WHERE id = NEW.item_id;
  SELECT rate_bp INTO NEW.vat_rate_bp FROM md.vat_categories WHERE id = NEW.vat_category_id;
  IF TG_TABLE_NAME = 'document_lines' THEN
    SELECT code INTO NEW.vat_category_code FROM md.vat_categories WHERE id = NEW.vat_category_id;
    SELECT item_type INTO NEW.item_type FROM md.items WHERE id = NEW.item_id;
  END IF;
  -- A credit or debit note line follows its original invoice line: the price it was sold at, the
  -- same "includes VAT" basis and the same VAT category and rate, not today's item settings.
  -- (Nested: quotation lines have no original line, and a record has only its own fields.)
  IF TG_TABLE_NAME = 'document_lines' THEN
    IF NEW.original_line_id IS NOT NULL THEN
      SELECT ol.unit_price_4dp, ol.price_includes_vat, ol.vat_category_id, ol.vat_category_code,
             ol.vat_rate_bp
        INTO NEW.list_price_4dp, NEW.price_includes_vat, NEW.vat_category_id, NEW.vat_category_code,
             NEW.vat_rate_bp
        FROM sales.document_lines ol
       WHERE ol.id = NEW.original_line_id;
    END IF;
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
