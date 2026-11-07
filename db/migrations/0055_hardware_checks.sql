-- 0055_hardware_checks.sql
-- Purpose: the guided hardware check, the only human step of the acceptance (M7 part D,
-- decision 0119).
--  1. ops.hardware_checks: one row per check, made by the owner on the PC it checks. On a POS PC:
--     a test receipt, the drawer, a test label, and the scan of that label's barcode; on an office
--     PC or the laptop: an A4 test page through the print dialog. Each step is «تمام» (ok) or
--     «فيه مشكلة» (problem) with an optional note. A check is kept as it was made: never changed,
--     never deleted, audited. System health shows the newest one of each PC beside the rehearsal.
--  2. system.health.manage (the owner's System health confirmations) now also covers this check.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0055: the hardware check (0119)');

CREATE TABLE ops.hardware_checks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id   bigint NOT NULL REFERENCES auth.devices (id),
  -- [{step, outcome: 'ok' | 'problem', note?}]
  results     jsonb NOT NULL CHECK (jsonb_typeof(results) = 'array' AND jsonb_array_length(results) BETWEEN 1 AND 5),
  all_ok      boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint NOT NULL REFERENCES auth.users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint NOT NULL REFERENCES auth.users (id),
  row_version integer NOT NULL DEFAULT 1
);
CREATE INDEX hardware_checks_device_ix ON ops.hardware_checks (device_id, created_at DESC);
COMMENT ON TABLE ops.hardware_checks IS
  'The guided hardware check (decision 0119): receipt, drawer, label and scan on a POS PC; an A4 page on an office PC. Kept as made.';

-- Only the owner checks, on the PC being checked; all_ok says whether every step was ok.
CREATE FUNCTION ops.hardware_check_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT auth.is_owner(sys.require_user()) THEN
    RAISE EXCEPTION 'Only the owner records the hardware check' USING ERRCODE = 'AP010';
  END IF;
  IF NEW.device_id IS DISTINCT FROM sys.ctx_device_id() THEN
    RAISE EXCEPTION 'A hardware check is recorded on the PC it checks' USING ERRCODE = '23514';
  END IF;
  IF NEW.all_ok IS DISTINCT FROM NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.results) r WHERE r ->> 'outcome' IS DISTINCT FROM 'ok') THEN
    RAISE EXCEPTION 'all_ok must say whether every step was ok' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_hardware_check_guard BEFORE INSERT ON ops.hardware_checks
  FOR EACH ROW EXECUTE FUNCTION ops.hardware_check_guard();
SELECT sys.add_touch('ops.hardware_checks');
SELECT audit.enable_for('ops.hardware_checks');
SELECT sys.forbid_delete('ops.hardware_checks');

UPDATE auth.permissions
   SET name_ar = 'تأكيدات صحة النظام (الـ UPS وفحص الأجهزة)',
       name_en = 'System health confirmations (the UPS, the hardware check)'
 WHERE code = 'system.health.manage';

-- Recorded through the API; never changed (no UPDATE for anyone).
GRANT SELECT, INSERT (device_id, results, all_ok) ON ops.hardware_checks TO artepool_api;
GRANT SELECT ON ops.hardware_checks TO artepool_backup;
