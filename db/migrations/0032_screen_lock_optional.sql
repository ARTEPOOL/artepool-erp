-- 0032_screen_lock_optional.sql
-- Purpose: the idle screen lock can be turned off (decision 0079). 0 minutes = never lock; the
-- session still ends after security.session_max_hours. The owner turned it off on every PC.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0032: the screen lock can be turned off (decision 0079)');

-- The idle-lock settings may now be 0 (off).
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
    "security.trusted_device_days": [0, 3650]
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
  RETURN NEW;
END $$;

UPDATE sys.settings SET value = '0',
       description = 'Office PCs lock after this many idle minutes; 0 = never (decision 0079)'
 WHERE key = 'security.idle_lock_minutes.office';
UPDATE sys.settings SET value = '0',
       description = 'POS PCs lock after this many idle minutes; 0 = never (decision 0079)'
 WHERE key = 'security.idle_lock_minutes.pos';
