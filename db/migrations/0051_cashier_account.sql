-- 0051_cashier_account.sql
-- Purpose: the cashier's Windows account on System health (M6.4, decision 0085 simplified).
--  1. ops.server_health records the account's state as `artepool-svc cashier-account check`
--     reports it: ok / repair / not_set_up, and the missing items by name (never a password).
--     The server PC's updater (SYSTEM, as the backup role) checks once an hour; the emergency
--     tool's "Set up / repair" (as the API role) records its result at once.
--  2. Only the server PC's own programs write these columns (the system user, id 1): no
--     request from a screen can make a broken account look right.
--  3. The hourly "last checked" time is not audited (the audit log's ignored-columns rule), so
--     the log gets an entry when the state changes or the owner sets the account up, not every
--     hour.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0051: the cashier''s Windows account (M6.4)');

ALTER TABLE ops.server_health
  ADD COLUMN cashier_account_state text
    CHECK (cashier_account_state IN ('ok', 'repair', 'not_set_up')),
  ADD COLUMN cashier_account_missing text[] NOT NULL DEFAULT '{}'
    CHECK (cashier_account_missing <@ ARRAY['account', 'enabled', 'standard', 'password_expiry',
                                            'auto_sign_in', 'password_stored', 'plain_password',
                                            'enrollment', 'folders', 'services',
                                            'active_hours']::text[]),
  ADD COLUMN cashier_account_checked_at timestamptz,
  ADD COLUMN cashier_account_setup_at timestamptz;
COMMENT ON COLUMN ops.server_health.cashier_account_state IS
  'M6.4: the cashier''s Windows account as last checked: ok, repair (something missing) or not_set_up; null: never checked.';
COMMENT ON COLUMN ops.server_health.cashier_account_missing IS
  'M6.4: what is missing, by name (account, standard, auto_sign_in, password_stored, enrollment, folders, services, active_hours, ...).';
COMMENT ON COLUMN ops.server_health.cashier_account_checked_at IS
  'M6.4: when the account was last checked (hourly by the updater; not audited).';
COMMENT ON COLUMN ops.server_health.cashier_account_setup_at IS
  'M6.4: when the owner last ran "Set up / repair the cashier account" in the emergency tool.';

-- The UPS rule stays; the cashier account's columns are written by the system user only.
CREATE OR REPLACE FUNCTION ops.server_health_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ups_confirmed_at IS DISTINCT FROM OLD.ups_confirmed_at
     AND NOT auth.is_owner(sys.require_user()) THEN
    RAISE EXCEPTION 'Only the owner confirms the UPS' USING ERRCODE = 'AP010';
  END IF;
  IF (NEW.cashier_account_state, NEW.cashier_account_missing, NEW.cashier_account_checked_at,
      NEW.cashier_account_setup_at)
     IS DISTINCT FROM (OLD.cashier_account_state, OLD.cashier_account_missing,
                       OLD.cashier_account_checked_at, OLD.cashier_account_setup_at)
     AND sys.require_user() <> 1 THEN
    RAISE EXCEPTION 'Only the server PC''s own programs record the cashier account'
      USING ERRCODE = 'AP010';
  END IF;
  RETURN NEW;
END $$;

-- The same audit trigger, now ignoring the hourly check time.
DROP TRIGGER z_audit ON ops.server_health;
SELECT audit.enable_for('ops.server_health', ARRAY['cashier_account_checked_at']);

GRANT UPDATE (cashier_account_state, cashier_account_missing, cashier_account_checked_at)
  ON ops.server_health TO artepool_backup;
GRANT UPDATE (cashier_account_state, cashier_account_missing, cashier_account_checked_at,
              cashier_account_setup_at)
  ON ops.server_health TO artepool_api;
