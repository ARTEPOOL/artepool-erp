-- One turn for numbering (found by the M7 rehearsal, decision 0119).
--
-- One business operation takes numbers from several series, in its own order: a POS sale takes
-- POS-, then JV- (its journal), then RCT- (its payment); a receipt takes RCT- then JV-; an oversell
-- takes JV- (the adjustment's journal) before POS-. With two tills and the office saving at the
-- same moment, two transactions could each hold one series and wait for the other's (a deadlock):
-- PostgreSQL cancels one after a second and the cashier sees "busy, try again".
--
-- Now every transaction takes one shared numbering turn before its first number and keeps it until
-- it ends (commit or rollback). Transactions that take numbers wait for each other at their first
-- number instead of in the middle, so two series can never be held by two transactions at once.
-- They already took their journal numbers one after another (every posting operation takes JV-),
-- so this adds no real waiting. Numbers stay gapless: the series row is still locked and a rollback
-- still gives its number back.
CREATE OR REPLACE FUNCTION sys.next_number(p_series_id bigint, OUT seq_no bigint, OUT formatted text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_prefix text;
  v_width smallint;
  v_digits text;
BEGIN
  -- Taken again by the same transaction, it returns at once.
  PERFORM pg_advisory_xact_lock(hashtext('sys.document_series: numbering turn'));
  UPDATE sys.document_series
     SET next_number = next_number + 1
   WHERE id = p_series_id AND is_active
  RETURNING next_number - 1, prefix, number_width INTO seq_no, v_prefix, v_width;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Numbering series % was not found or is not active', p_series_id USING ERRCODE = 'AP007';
  END IF;
  v_digits := seq_no::text;
  formatted := v_prefix || CASE WHEN length(v_digits) >= v_width THEN v_digits
                                ELSE lpad(v_digits, v_width, '0') END;
END $$;
