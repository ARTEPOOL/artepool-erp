-- 0030_trust_until_password_change.sql
-- Purpose: the 2-step code once per PC (decision 0077). After the phone code on a PC, the person
-- signs in there with the password alone until the password changes (or the 2-step setup, the
-- user or the PC changes, as in decision 0027). Technically a trust now lasts up to 3650 days.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0030: the 2-step code once per PC (decision 0077)');

-- The setting may now go up to 3650 days (10 years: in practice, until the password changes).
CREATE OR REPLACE FUNCTION sys.check_setting() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ranges CONSTANT jsonb := '{
    "security.max_failed_logins": [3, 10],
    "security.lockout_minutes": [1, 1440],
    "security.idle_lock_minutes.office": [1, 240],
    "security.idle_lock_minutes.pos": [1, 240],
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

ALTER TABLE auth.device_trust DROP CONSTRAINT device_trust_expiry_ck;
ALTER TABLE auth.device_trust ADD CONSTRAINT device_trust_expiry_ck CHECK (
  expires_at > created_at AND expires_at <= created_at + interval '3650 days');

UPDATE sys.settings
   SET value = '3650',
       description = 'Days a PC stays remembered after the 2-step code there; 3650 = until the password changes; 0 turns it off (decisions 0027, 0077)'
 WHERE key = 'security.trusted_device_days';

COMMENT ON TABLE auth.device_trust IS
  'PCs where a 2-step user signs in with the password alone until the password changes (decisions 0027, 0077).';
