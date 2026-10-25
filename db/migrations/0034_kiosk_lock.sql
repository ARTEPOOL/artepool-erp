-- 0034_kiosk_lock.sql
-- Purpose: the POS kiosk lock (decisions 0082, 0083, 0089). Each POS PC has a "Kiosk lock" kept
-- here on the server, never on the PC: ON unless the owner turned it off, for a time or until
-- turned back on. Every change is a row (never deleted); the latest row is the state. Only the
-- owner changes it: from Settings with a reason (the API checks a fresh 2-step code), or with the
-- owner's code typed on the lock screen, for at most 5 minutes. Wrong lock-screen codes are kept
-- to limit guessing. New alert types for the owner.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0034: the POS kiosk lock (decisions 0082, 0083, 0089)');

-- ---------------------------------------------------------------------------------------------
-- Changes of a PC's kiosk lock: append-only, the latest one is the state
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.kiosk_lock_changes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id   bigint NOT NULL REFERENCES auth.devices (id),
  lock_on     boolean NOT NULL,
  -- Off: until when (empty = until the owner turns it back on). On: always empty.
  off_until   timestamptz,
  via         text NOT NULL CHECK (via IN ('settings', 'owner_code')),
  reason      text CHECK (length(reason) BETWEEN 3 AND 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint NOT NULL REFERENCES auth.users (id),
  CONSTRAINT kiosk_lock_on_ck CHECK (NOT lock_on OR off_until IS NULL),
  CONSTRAINT kiosk_lock_code_ck CHECK (via <> 'owner_code' OR (NOT lock_on AND off_until IS NOT NULL))
);
CREATE INDEX kiosk_lock_changes_device_ix ON auth.kiosk_lock_changes (device_id, id DESC);
COMMENT ON TABLE auth.kiosk_lock_changes IS
  'Each change of a POS PC''s kiosk lock; the latest is the state, none = on (decisions 0083, 0089).';

-- Only the owner, only on an active POS PC; a reason from Settings; at most 5 minutes by code.
CREATE FUNCTION auth.kiosk_lock_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d auth.devices;
BEGIN
  SELECT * INTO d FROM auth.devices WHERE id = NEW.device_id;
  IF NOT auth.is_owner(sys.require_user()) THEN
    RAISE EXCEPTION 'Only the owner changes the kiosk lock' USING ERRCODE = 'AP010';
  END IF;
  IF d.id IS NULL OR d.status <> 'active' OR d.device_kind <> 'pos' THEN
    RAISE EXCEPTION 'The kiosk lock exists only on active POS PCs' USING ERRCODE = 'AP010';
  END IF;
  IF NEW.via = 'settings' AND NEW.reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required' USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.lock_on AND NEW.off_until IS NOT NULL AND NEW.off_until <= now() THEN
    RAISE EXCEPTION 'The lock must be off until a later time' USING ERRCODE = '23514';
  END IF;
  IF NEW.via = 'owner_code' AND NEW.off_until > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'The owner code lifts the lock for at most 5 minutes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_kiosk_lock_before_insert BEFORE INSERT ON auth.kiosk_lock_changes
  FOR EACH ROW EXECUTE FUNCTION auth.kiosk_lock_before_insert();
SELECT sys.add_stamp('auth.kiosk_lock_changes');
SELECT sys.add_immutable_guard('auth.kiosk_lock_changes', '', '', '');
SELECT audit.enable_for('auth.kiosk_lock_changes');
SELECT sys.forbid_delete('auth.kiosk_lock_changes');

-- A PC's lock now: on unless its latest change turned it off and that time has not passed.
CREATE FUNCTION auth.kiosk_state(p_device_id bigint,
                                 OUT locked boolean, OUT off_until timestamptz, OUT change_id bigint)
LANGUAGE sql STABLE AS $$
  SELECT coalesce(NOT (NOT c.lock_on AND (c.off_until IS NULL OR c.off_until > now())), true),
         CASE WHEN NOT c.lock_on AND (c.off_until IS NULL OR c.off_until > now()) THEN c.off_until END,
         c.id
    FROM (SELECT 1) one
    LEFT JOIN LATERAL (SELECT * FROM auth.kiosk_lock_changes k
                        WHERE k.device_id = p_device_id ORDER BY k.id DESC LIMIT 1) c ON true
$$;

-- ---------------------------------------------------------------------------------------------
-- Wrong owner codes typed on a lock screen: 5 in 15 minutes close the door for 15 minutes
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.kiosk_code_failures (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id   bigint NOT NULL REFERENCES auth.devices (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint NOT NULL REFERENCES auth.users (id)
);
CREATE INDEX kiosk_code_failures_ix ON auth.kiosk_code_failures (device_id, created_at);
SELECT sys.add_stamp('auth.kiosk_code_failures');
SELECT sys.add_immutable_guard('auth.kiosk_code_failures', '', '', '');
SELECT audit.enable_for('auth.kiosk_code_failures');
SELECT sys.forbid_delete('auth.kiosk_code_failures');

-- ---------------------------------------------------------------------------------------------
-- Alerts for the owner
-- ---------------------------------------------------------------------------------------------
ALTER TABLE sys.alerts DROP CONSTRAINT alerts_alert_type_check;
ALTER TABLE sys.alerts ADD CONSTRAINT alerts_alert_type_check CHECK (alert_type IN (
  'low_stock', 'oversell_review', 'cash_drop_due', 'cash_variance',
  'repeated_variance', 'drawer_left_open', 'backup_failed', 'backup_stale',
  'restore_test_due', 'integrity_issue', 'audit_chain_broken', 'clock_skew',
  'clock_backwards', 'period_missing',
  'kiosk_lock_off', 'kiosk_lock_on', 'kiosk_exit_attempt', 'kiosk_code_blocked'));

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON auth.kiosk_lock_changes TO artepool_api;
GRANT INSERT (device_id, lock_on, off_until, via, reason) ON auth.kiosk_lock_changes TO artepool_api;
GRANT SELECT ON auth.kiosk_code_failures TO artepool_api;
GRANT INSERT (device_id) ON auth.kiosk_code_failures TO artepool_api;
GRANT EXECUTE ON FUNCTION auth.kiosk_state(bigint) TO artepool_api;
