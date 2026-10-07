-- 0006_device_trust.sql
-- Purpose: "Trust this PC" for the 2-step code (decision 0027). A 2-step user who ticks it signs in
-- on that PC with the password alone for a limited time; never on POS PCs. The trust ends by itself
-- when the password, the 2-step setup, the user or the PC changes, and it is never deleted.
-- Self-service password recovery (decision 0028) needs no schema change.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0006: trusted PCs for the 2-step code');

-- ---------------------------------------------------------------------------------------------
-- Settings: how long a PC stays trusted (0 turns the feature off and ignores existing trust)
-- ---------------------------------------------------------------------------------------------
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
    "security.trusted_device_days": [0, 90]
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

INSERT INTO sys.settings (key, value, description) VALUES
  ('security.trusted_device_days', '30',
   'Days a PC stays trusted for the 2-step code after the person ticks "Trust this PC"; 0 turns it off (decision 0027)');

-- Days a trust lasts now, or 0 when the feature is off.
CREATE FUNCTION auth.trusted_device_days() RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (value)::integer FROM sys.settings WHERE key = 'security.trusted_device_days'), 0)
$$;

-- ---------------------------------------------------------------------------------------------
-- Trusted PCs, per person: one open trust per person and PC. Ended with a reason, never deleted.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.device_trust (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES auth.users (id),
  device_id   bigint NOT NULL REFERENCES auth.devices (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint NOT NULL REFERENCES auth.users (id),
  expires_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  end_reason  text CHECK (end_reason IN ('replaced', 'ended_in_settings', 'password_changed',
                                         'two_step_changed', 'user_deactivated',
                                         'device_revoked', 'device_kind_changed')),
  CONSTRAINT device_trust_expiry_ck CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '90 days'),
  CONSTRAINT device_trust_end_ck CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CONSTRAINT device_trust_self_ck CHECK (created_by = user_id)
);
CREATE UNIQUE INDEX device_trust_open_uq ON auth.device_trust (user_id, device_id)
  WHERE ended_at IS NULL;
CREATE INDEX device_trust_open_device_ix ON auth.device_trust (device_id) WHERE ended_at IS NULL;
COMMENT ON TABLE auth.device_trust IS
  'PCs where a 2-step user may sign in with the password alone until expires_at (decision 0027).';

-- Only the person signing in, on that PC, with an active 2-step code; never a POS or revoked PC.
-- The length comes from the setting and the server clock, not from the caller.
CREATE FUNCTION auth.device_trust_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  u auth.users;
  d auth.devices;
  v_days integer := auth.trusted_device_days();
BEGIN
  SELECT * INTO u FROM auth.users WHERE id = NEW.user_id;
  SELECT * INTO d FROM auth.devices WHERE id = NEW.device_id;
  IF sys.require_user() <> NEW.user_id OR sys.ctx_device_id() IS DISTINCT FROM NEW.device_id THEN
    RAISE EXCEPTION 'Only the person signing in, on this PC, can trust it' USING ERRCODE = 'AP010';
  END IF;
  IF v_days = 0 THEN
    RAISE EXCEPTION 'Trusting a PC is turned off' USING ERRCODE = 'AP010';
  END IF;
  IF u.id IS NULL OR NOT u.is_active OR NOT u.totp_enabled THEN
    RAISE EXCEPTION 'Only users with an active 2-step code can trust a PC' USING ERRCODE = 'AP010';
  END IF;
  IF d.id IS NULL OR d.status <> 'active' OR d.device_kind = 'pos' THEN
    RAISE EXCEPTION 'POS PCs and revoked PCs cannot be trusted' USING ERRCODE = 'AP010';
  END IF;
  NEW.expires_at := now() + make_interval(days => v_days);
  NEW.ended_at := NULL;
  NEW.end_reason := NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER a_trust_before_insert BEFORE INSERT ON auth.device_trust
  FOR EACH ROW EXECUTE FUNCTION auth.device_trust_before_insert();

CREATE FUNCTION auth.guard_device_trust() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'This trust has already ended' USING ERRCODE = 'AP003';
  END IF;
  IF NEW.ended_at IS NOT NULL THEN
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_device_trust BEFORE UPDATE ON auth.device_trust
  FOR EACH ROW EXECUTE FUNCTION auth.guard_device_trust();
SELECT sys.add_stamp('auth.device_trust');
SELECT sys.add_immutable_guard('auth.device_trust', '', '', 'ended_at,end_reason');
SELECT audit.enable_for('auth.device_trust');
SELECT sys.forbid_delete('auth.device_trust');

-- The trust ends by itself when what it relied on changes: a new password (changed, reset or
-- recovered), a new or cleared 2-step setup, a deactivated user, a revoked PC, a PC turned POS.
CREATE FUNCTION auth.end_trust_on_user_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_reason text;
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    v_reason := 'user_deactivated';
  ELSIF NEW.totp_enabled IS DISTINCT FROM OLD.totp_enabled
        OR NEW.totp_secret_enc IS DISTINCT FROM OLD.totp_secret_enc THEN
    v_reason := 'two_step_changed';
  ELSIF NEW.password_changed_at IS DISTINCT FROM OLD.password_changed_at
        OR (NEW.must_change_password AND NEW.password_hash IS DISTINCT FROM OLD.password_hash) THEN
    v_reason := 'password_changed';
  ELSE
    RETURN NULL;
  END IF;
  UPDATE auth.device_trust SET ended_at = now(), end_reason = v_reason
   WHERE user_id = NEW.id AND ended_at IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER end_device_trust
  AFTER UPDATE OF is_active, totp_enabled, totp_secret_enc, password_changed_at, password_hash,
                  must_change_password ON auth.users
  FOR EACH ROW EXECUTE FUNCTION auth.end_trust_on_user_change();

CREATE FUNCTION auth.end_trust_on_device_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_reason text;
BEGIN
  IF OLD.status = 'active' AND NEW.status = 'revoked' THEN
    v_reason := 'device_revoked';
  ELSIF OLD.device_kind <> 'pos' AND NEW.device_kind = 'pos' THEN
    v_reason := 'device_kind_changed';
  ELSE
    RETURN NULL;
  END IF;
  UPDATE auth.device_trust SET ended_at = now(), end_reason = v_reason
   WHERE device_id = NEW.id AND ended_at IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER end_device_trust AFTER UPDATE OF status, device_kind ON auth.devices
  FOR EACH ROW EXECUTE FUNCTION auth.end_trust_on_device_change();

-- ---------------------------------------------------------------------------------------------
-- Sessions: a new sign-in method, "trusted_device" (password alone, on a PC the person trusted)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE auth.sessions DROP CONSTRAINT sessions_auth_method_check;
ALTER TABLE auth.sessions ADD CONSTRAINT sessions_auth_method_check
  CHECK (auth_method IN ('password', 'password_totp', 'recovery_code', 'pin', 'trusted_device'));

-- The sign-in rules of decisions 0021 and 0027, enforced where no API bug can skip them.
CREATE OR REPLACE FUNCTION auth.session_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  u auth.users;
  d auth.devices;
  v_days integer;
BEGIN
  NEW.created_at := now();
  NEW.last_activity_at := now();
  SELECT * INTO u FROM auth.users WHERE id = NEW.user_id;
  SELECT * INTO d FROM auth.devices WHERE id = NEW.device_id;
  IF u.id IS NULL OR u.id = 1 OR NOT u.is_active THEN
    RAISE EXCEPTION 'This user cannot sign in' USING ERRCODE = 'AP010';
  END IF;
  IF d.id IS NULL OR d.status <> 'active' OR d.key_expires_at <= now() THEN
    RAISE EXCEPTION 'This device is not allowed to sign in' USING ERRCODE = 'AP010';
  END IF;
  IF (NEW.auth_method = 'pin') <> (u.sign_in_method = 'pin') THEN
    RAISE EXCEPTION 'Sign-in method % is not this user''s method', NEW.auth_method USING ERRCODE = 'AP010';
  END IF;
  IF NEW.auth_method = 'pin' AND d.device_kind <> 'pos' THEN
    RAISE EXCEPTION 'PIN sign-in works only on POS devices' USING ERRCODE = 'AP010';
  END IF;
  IF NEW.auth_method IN ('password_totp', 'recovery_code', 'trusted_device')
     AND u.sign_in_method <> 'password_totp' THEN
    RAISE EXCEPTION 'This user does not use the 2-step code' USING ERRCODE = 'AP010';
  END IF;
  IF NEW.auth_method IN ('password_totp', 'trusted_device') AND NOT u.totp_enabled THEN
    RAISE EXCEPTION 'The 2-step code is not set up for this user' USING ERRCODE = 'AP010';
  END IF;
  -- A password alone gives a full session only to users without an active 2-step code
  -- (password users, or 2-step users who must set it up first).
  IF NEW.auth_method = 'password' AND NEW.stage = 'full' AND u.totp_enabled THEN
    RAISE EXCEPTION 'The 2-step code is required' USING ERRCODE = 'AP010';
  END IF;
  -- ... or on a PC the person trusted, still within the current setting (decision 0027).
  IF NEW.auth_method = 'trusted_device' THEN
    v_days := auth.trusted_device_days();
    IF d.device_kind = 'pos' OR v_days = 0 OR NOT EXISTS (
         SELECT 1 FROM auth.device_trust t
          WHERE t.user_id = u.id AND t.device_id = d.id AND t.ended_at IS NULL
            AND t.expires_at > now() AND t.created_at + make_interval(days => v_days) > now()) THEN
      RAISE EXCEPTION 'This PC is not trusted for this user' USING ERRCODE = 'AP010';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION auth.trusted_device_days() TO artepool_api;
GRANT SELECT ON auth.device_trust TO artepool_api;
GRANT INSERT (user_id, device_id) ON auth.device_trust TO artepool_api;
GRANT UPDATE (ended_at, end_reason) ON auth.device_trust TO artepool_api;
