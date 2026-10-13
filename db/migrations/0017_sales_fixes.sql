-- 0017_sales_fixes.sql
-- Purpose: four gaps found while building the sales API on 0015 (not a change of any decision):
--   1. a credit note on a payment invoice (work cancelled) carries the advance line it reverses;
--   2. a credit note can settle a payment invoice (when a bounced cheque leaves it unpaid);
--   3. an invoice line converted from a quotation keeps the quotation's agreed price as its list
--      price, so it is not a "changed price" at issue (decision 0049);
--   4. the prices and discounts of a quotation are approved when it is sent: a changed price or a
--      discount above the limit needs the permission or a supervisor's approval (0012, 0049);
--   5. an unpaid amount beyond the customer's credit is allowed to someone who holds
--      sales.credit_over_limit, as discounts and prices already are (0046).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0017: sales fixes (decisions 0012, 0013, 0049)');

ALTER TABLE sales.document_lines ADD COLUMN quotation_line_id bigint REFERENCES sales.quotation_lines (id);
GRANT INSERT (quotation_line_id) ON sales.document_lines TO artepool_api;

-- 1
CREATE OR REPLACE FUNCTION sales.document_line_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d record;
  o record;
BEGIN
  SELECT x.doc_type, x.customer_id, x.original_document_id, od.doc_type AS original_type
    INTO d FROM sales.documents x LEFT JOIN sales.documents od ON od.id = x.original_document_id
   WHERE x.id = NEW.document_id;
  -- A credit note on a payment invoice reverses its advance (work cancelled, decision 0013).
  IF (NEW.line_kind = 'advance' AND d.doc_type <> 'advance_invoice'
      AND NOT (d.doc_type = 'credit_note' AND d.original_type = 'advance_invoice'))
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

-- 2
CREATE OR REPLACE FUNCTION sales.credit_allocation_rules() RETURNS trigger
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
    IF t.customer_id <> n.customer_id OR t.status <> 'issued' OR t.doc_type NOT IN ('invoice', 'advance_invoice', 'debit_note') THEN
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

-- 3
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
  SELECT * INTO a FROM sales.line_amounts(NEW.quantity, NEW.unit_price_4dp, NEW.price_includes_vat,
                                          NEW.vat_rate_bp, NEW.line_discount_fils, NEW.doc_discount_alloc_fils);
  NEW.amount_before_discount_fils := a.amount_before_fils;
  NEW.net_fils := a.net_fils;
  NEW.vat_fils := a.vat_fils;
  NEW.gross_fils := a.gross_fils;
  NEW.discount_excl_vat_fils := a.discount_excl_vat_fils;
  RETURN NEW;
END $$;

-- 4
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
      IF NEW.approval_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.approvals WHERE id = NEW.approval_id
           AND permission_code IN ('sales.discount_over_limit', 'sales.price_override')) THEN
        RAISE EXCEPTION 'This approval is for something else' USING ERRCODE = 'AP012', HINT = 'APPROVAL_INVALID';
      END IF;
      IF NEW.approval_id IS NULL AND NOT auth.user_has_permission(v_user, 'sales.price_override')
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

-- 5
CREATE OR REPLACE FUNCTION sales.document_commit_checks() RETURNS trigger
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
  -- Decision 0046: beyond the customer's credit only with a supervisor's approval, or when the
  -- person issuing holds sales.credit_over_limit themselves (as for discounts and prices).
  IF d.doc_type IN ('invoice', 'debit_note') AND d.settled_fils < d.total_fils AND d.credit_approval_id IS NULL
     AND NOT auth.user_has_permission(d.issued_by, 'sales.credit_over_limit') THEN
    SELECT credit_mode, credit_limit_fils INTO c FROM md.customers WHERE id = d.customer_id;
    v_limit := CASE WHEN c.credit_mode = 'credit' THEN c.credit_limit_fils ELSE 0 END;
    IF sales.customer_balance(d.customer_id) > v_limit THEN
      RAISE EXCEPTION 'This unpaid amount is above the customer''s credit' USING ERRCODE = 'AP012', HINT = 'CREDIT_LIMIT';
    END IF;
  END IF;
  RETURN NULL;
END $$;
