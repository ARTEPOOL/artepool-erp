-- 0047_power_loss.sql
-- Purpose: power loss and integrity (M6.2 part I).
--  1. ops.integrity_runs.run_kind 'after_start': the backup service runs the integrity checks
--     once after every start of the database (after a power cut too), not only at night.
--  2. The alert 'durability_off': a setting that keeps confirmed sales through a power cut is off
--     (fsync, synchronous_commit, full_page_writes, wal_sync_method on Windows, data checksums).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0047: power loss and integrity (M6.2 part I)');

ALTER TABLE ops.integrity_runs DROP CONSTRAINT integrity_runs_run_kind_check;
ALTER TABLE ops.integrity_runs ADD CONSTRAINT integrity_runs_run_kind_check
  CHECK (run_kind IN ('nightly', 'restore_test', 'manual', 'after_start'));

ALTER TABLE sys.alerts DROP CONSTRAINT alerts_alert_type_check;
ALTER TABLE sys.alerts ADD CONSTRAINT alerts_alert_type_check CHECK (alert_type IN (
  'low_stock', 'oversell_review', 'cash_drop_due', 'cash_variance',
  'repeated_variance', 'drawer_left_open', 'backup_failed', 'backup_stale',
  'restore_test_due', 'integrity_issue', 'audit_chain_broken', 'clock_skew',
  'clock_backwards', 'period_missing',
  'kiosk_lock_off', 'kiosk_lock_on', 'kiosk_exit_attempt', 'kiosk_code_blocked',
  'offline_copy_due',
  'ups_unconfirmed', 'disk_low', 'disk_urgent', 'service_down', 'wal_archive_failed',
  'certificate_expiring', 'certificate_renewal_failed', 'root_ca_expiring',
  'durability_off'));
