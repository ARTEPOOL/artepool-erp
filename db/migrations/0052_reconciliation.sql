-- 0052_reconciliation.sql
-- Purpose: the reconciliation report (M7, decision 0119).
--  1. Permission `reports.reconciliation` for the owner and the accountant: the seven steps of
--     the acceptance reconciliation (stock, cash, invoices, VAT, accounts, audit, backup).
--  2. ops.integrity_runs keeps each report: run_kind 'reconciliation', with its period; the API
--     records it (the nightly checks stay the backup service's).
--  3. The nightly checks recompute every closed shift's expected cash with cash.expected_cash,
--     so the backup role may call it.
--  4. Every Z report carries the audit chain's anchor (§6.3 step 6): at the close, the chain's
--     head is copied into audit.anchors ('z_report', the shift number) and onto the shift, so a
--     chain rewritten later cannot match the copy printed with the shift.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0052: the reconciliation report (decision 0119)');

INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('reports.reconciliation', 'reports', 'تقرير المطابقة',
        'Reconciliation report', true, false, false);
INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT id, 'reports.reconciliation' FROM auth.roles WHERE code IN ('owner', 'accountant');

ALTER TABLE ops.integrity_runs DROP CONSTRAINT integrity_runs_run_kind_check;
ALTER TABLE ops.integrity_runs ADD CONSTRAINT integrity_runs_run_kind_check
  CHECK (run_kind IN ('nightly', 'restore_test', 'manual', 'after_start', 'reconciliation'));
ALTER TABLE ops.integrity_runs
  ADD COLUMN period_from date,
  ADD COLUMN period_to date,
  ADD CONSTRAINT integrity_runs_period_ck CHECK (
    (run_kind = 'reconciliation') = (period_from IS NOT NULL AND period_to IS NOT NULL)
    AND (period_from IS NULL OR period_from <= period_to));
GRANT INSERT (run_kind, database_name, started_at, finished_at, status, results, period_from, period_to)
  ON ops.integrity_runs TO artepool_api;

GRANT EXECUTE ON FUNCTION cash.expected_cash(bigint) TO artepool_backup;

-- The close as in 0022, plus the Z report's audit anchor.
CREATE OR REPLACE FUNCTION cash.shift_close_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_count record;
  v_anchor audit.anchors;
BEGIN
  PERFORM cash.assert_shift_owner(OLD.id);
  -- The final count is the recount when there is one, else the closing count.
  SELECT id, total_fils INTO v_count FROM cash.counts
   WHERE shift_id = OLD.id AND purpose = 'closing'
   ORDER BY (supersedes_id IS NOT NULL) DESC LIMIT 1;
  IF v_count.id IS NULL THEN
    RAISE EXCEPTION 'A shift closes after its cash is counted' USING ERRCODE = 'AP011', HINT = 'COUNT_MISSING';
  END IF;
  NEW.closing_count_id := v_count.id;
  NEW.counted_cash_fils := v_count.total_fils;
  NEW.expected_cash_fils := cash.expected_cash(OLD.id);
  NEW.variance_fils := NEW.counted_cash_fils - NEW.expected_cash_fils;
  -- The counted cash leaves the drawer for the safe (posting map row 18), in this transaction.
  IF NEW.counted_cash_fils > 0 AND NOT EXISTS (SELECT 1 FROM cash.movements
       WHERE shift_id = OLD.id AND movement_type = 'closing_transfer' AND amount_fils = NEW.counted_cash_fils) THEN
    RAISE EXCEPTION 'The counted cash must go to the safe' USING ERRCODE = 'AP011', HINT = 'CLOSING_TRANSFER';
  END IF;
  -- The chain as sealed before this close, kept with the Z report (decision 0119).
  v_anchor := audit.add_anchor('z_report', OLD.shift_number);
  NEW.audit_anchor_seq := v_anchor.chain_seq;
  NEW.audit_anchor_hash := v_anchor.chain_hash;
  RETURN NEW;
END $$;
