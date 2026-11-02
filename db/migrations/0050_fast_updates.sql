-- 0050_fast_updates.sql
-- Purpose: fast updates (decision 0115).
--  1. The download's progress (bytes received, total, speed, when), written by the updater at
--     most once a second. The audit log ignores these four columns (its ignored-columns rule), so
--     a download does not add hundreds of entries; the status changes stay audited.
--  2. "Check now" answers in seconds: the server reads the update list itself and records the
--     result. Its role may write those columns only for the owner (the guard below).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0050: fast updates (decision 0115)');

ALTER TABLE ops.update_state
  ADD COLUMN download_bytes bigint CHECK (download_bytes >= 0),
  ADD COLUMN download_total bigint CHECK (download_total >= 0),
  ADD COLUMN download_rate bigint CHECK (download_rate >= 0),
  ADD COLUMN progress_at timestamptz;
COMMENT ON COLUMN ops.update_state.download_bytes IS
  'Decision 0115: bytes of the update received so far (not audited; written at most once a second).';
COMMENT ON COLUMN ops.update_state.download_total IS
  'Decision 0115: the size of the update being downloaded, when the server said it.';
COMMENT ON COLUMN ops.update_state.download_rate IS
  'Decision 0115: the download speed in bytes per second (for "time left").';
COMMENT ON COLUMN ops.update_state.progress_at IS
  'Decision 0115: when the progress was last written; an old one means the download is paused.';

-- The same audit trigger, now ignoring the progress columns.
DROP TRIGGER z_audit ON ops.update_state;
SELECT audit.enable_for('ops.update_state',
                        ARRAY['download_bytes', 'download_total', 'download_rate', 'progress_at']);

CREATE OR REPLACE FUNCTION ops.update_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.check_requested_at IS DISTINCT FROM OLD.check_requested_at
     AND NOT auth.is_owner(sys.require_user()) THEN
    RAISE EXCEPTION 'Only the owner checks for updates' USING ERRCODE = 'AP010';
  END IF;
  -- Decision 0115: the server records the result of the owner's "Check now" itself.
  IF current_user = 'artepool_api'
     AND (NEW.checked_at, NEW.check_error, NEW.available_version, NEW.notes_ar, NEW.notes_en,
          NEW.published_at)
         IS DISTINCT FROM
         (OLD.checked_at, OLD.check_error, OLD.available_version, OLD.notes_ar, OLD.notes_en,
          OLD.published_at)
     AND NOT auth.is_owner(sys.require_user()) THEN
    RAISE EXCEPTION 'Only the owner checks for updates' USING ERRCODE = 'AP010';
  END IF;
  RETURN NEW;
END $$;

GRANT UPDATE (checked_at, check_error, available_version, notes_ar, notes_en, published_at)
  ON ops.update_state TO artepool_api;
GRANT UPDATE (download_bytes, download_total, download_rate, progress_at)
  ON ops.update_state TO artepool_backup;
