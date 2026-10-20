-- 0037_label_sizes_two_inch.sql
-- Purpose: decision 0096 (updates 0043). The shop's label printer takes a 2-inch roll: 50 × 30 mm is
-- the default size, then 50 × 25 and 40 × 30. Sizes that cannot work on it (25 × 15 and 30 × 20 are
-- too small for a readable barcode and name; 58 × 40 and 100 × 50 are wider than the roll) are
-- deactivated with a reason, never deleted. A size wider than the roll (setting
-- labels.max_width_mm, 50 mm by default) cannot be added or switched back on.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0037: label sizes for the 2-inch label printer (decision 0096)');

-- ---------------------------------------------------------------------------------------------
-- Setting: the widest label the printer's roll takes
-- ---------------------------------------------------------------------------------------------
INSERT INTO sys.settings (key, value, description) VALUES
  ('labels.max_width_mm', '50', 'Widest barcode label (mm) the label printer''s roll takes (2-inch roll: 50)');

CREATE OR REPLACE FUNCTION sys.check_setting() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ranges CONSTANT jsonb := '{
    "security.max_failed_logins": [3, 10],
    "security.lockout_minutes": [1, 1440],
    "security.idle_lock_minutes.office": [0, 240],
    "security.idle_lock_minutes.pos": [0, 240],
    "security.session_max_hours": [1, 24],
    "security.approval_validity_seconds": [30, 3600],
    "security.max_failed_pins": [3, 10],
    "security.password_min_length": [10, 128],
    "security.enrollment_code_minutes": [1, 60],
    "security.enrollment_max_attempts": [1, 10],
    "security.device_key_days": [30, 730],
    "security.trusted_device_days": [0, 3650],
    "backup.max_age_minutes.local": [30, 1440],
    "backup.max_age_hours.offsite": [24, 168],
    "backup.restore_test_interval_days": [7, 90],
    "backup.offline_copy_interval_days": [1, 60],
    "labels.max_width_mm": [20, 210]
  }';
  v_range jsonb := v_ranges -> NEW.key;
  v_number numeric;
BEGIN
  IF v_range IS NOT NULL THEN
    IF jsonb_typeof(NEW.value) = 'number' THEN
      v_number := (NEW.value)::numeric;
    END IF;
    IF v_number IS NULL OR v_number <> trunc(v_number)
       OR v_number NOT BETWEEN (v_range ->> 0)::numeric AND (v_range ->> 1)::numeric THEN
      RAISE EXCEPTION 'Setting % must be a whole number from % to %', NEW.key, v_range ->> 0, v_range ->> 1
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.key = 'client.min_version'
     AND (jsonb_typeof(NEW.value) <> 'string' OR NEW.value #>> '{}' !~ '^[0-9]+\.[0-9]+\.[0-9]+$') THEN
    RAISE EXCEPTION 'Setting client.min_version must look like 1.2.3' USING ERRCODE = '23514';
  END IF;
  IF NEW.key = 'backup.age_recipient' AND jsonb_typeof(NEW.value) <> 'null'
     AND (jsonb_typeof(NEW.value) <> 'string' OR NEW.value #>> '{}' !~ '^age1[02-9ac-hj-np-z]{58}$') THEN
    RAISE EXCEPTION 'Setting backup.age_recipient must be an age public key (age1…)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------
-- The sizes: deactivate the ones the 2-inch printer cannot print well, put 50 × 30 first
-- ---------------------------------------------------------------------------------------------
UPDATE md.label_sizes SET is_active = false WHERE code IN ('25X15', '30X20', '58X40', '100X50');
UPDATE md.label_sizes SET sort_order = CASE code
    WHEN '50X30' THEN 1
    WHEN '50X25' THEN 2
    WHEN '40X30' THEN 3
    WHEN '38X25' THEN 4
    ELSE sort_order + 10
  END
 WHERE code IN ('50X30', '50X25', '40X30', '38X25', '25X15', '30X20', '58X40', '100X50');

-- An active size is never wider than the roll; the first active size is the default.
CREATE FUNCTION md.label_size_fits_roll() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_max integer := (SELECT (value #>> '{}')::integer FROM sys.settings WHERE key = 'labels.max_width_mm');
BEGIN
  IF NEW.is_active AND NEW.width_mm > v_max
     AND (TG_OP = 'INSERT' OR NOT OLD.is_active OR NEW.width_mm <> OLD.width_mm) THEN
    RAISE EXCEPTION 'Label width % mm is wider than the label roll (% mm)', NEW.width_mm, v_max
      USING ERRCODE = 'AP011', HINT = 'LABEL_TOO_WIDE';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER b_label_size_fits_roll BEFORE INSERT OR UPDATE OF width_mm, is_active ON md.label_sizes
  FOR EACH ROW EXECUTE FUNCTION md.label_size_fits_roll();
