-- 0031_owner_trust_on_pos.sql
-- Purpose: the owner, and only the owner, may have a POS PC remember the 2-step code until the
-- password changes (decision 0078). Everyone else still types the code on POS PCs every time.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0031: the owner may trust a POS PC (decision 0078)');

-- Whether this user holds the owner role.
CREATE FUNCTION auth.is_owner(p_user_id bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM auth.user_roles
                  WHERE user_id = p_user_id AND role_id = auth.owner_role_id())
$$;
GRANT EXECUTE ON FUNCTION auth.is_owner(bigint) TO artepool_api;

-- Trusting a PC: a POS PC only for the owner.
CREATE OR REPLACE FUNCTION auth.device_trust_before_insert() RETURNS trigger
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
  IF d.id IS NULL OR d.status <> 'active' OR (d.device_kind = 'pos' AND NOT auth.is_owner(u.id)) THEN
    RAISE EXCEPTION 'Revoked PCs, and POS PCs for anyone but the owner, cannot be trusted' USING ERRCODE = 'AP010';
  END IF;
  NEW.expires_at := now() + make_interval(days => v_days);
  NEW.ended_at := NULL;
  NEW.end_reason := NULL;
  RETURN NEW;
END $$;

-- Signing in with the password alone on a trusted PC: a POS PC only for the owner.
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
  -- ... or on a PC the person trusted (a POS PC only for the owner, decision 0078), still within the current setting (decision 0027).
  IF NEW.auth_method = 'trusted_device' THEN
    v_days := auth.trusted_device_days();
    IF (d.device_kind = 'pos' AND NOT auth.is_owner(u.id)) OR v_days = 0 OR NOT EXISTS (
         SELECT 1 FROM auth.device_trust t
          WHERE t.user_id = u.id AND t.device_id = d.id AND t.ended_at IS NULL
            AND t.expires_at > now() AND t.created_at + make_interval(days => v_days) > now()) THEN
      RAISE EXCEPTION 'This PC is not trusted for this user' USING ERRCODE = 'AP010';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION auth.end_trust_on_device_change() RETURNS trigger
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
  -- Turning a PC into a POS PC keeps only the owner's trust (decision 0078).
  UPDATE auth.device_trust SET ended_at = now(), end_reason = v_reason
   WHERE device_id = NEW.id AND ended_at IS NULL
     AND (v_reason = 'device_revoked' OR NOT auth.is_owner(user_id));
  RETURN NULL;
END $$;
