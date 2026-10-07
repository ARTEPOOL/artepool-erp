-- 0005_auth_devices.sql
-- Purpose: enrolled devices, enrollment codes, sessions, supervisor approvals, owner recovery
-- codes, idempotency keys, and the sign-in rules on users and roles
-- (docs/database-schema.md §4.7, §5.1, §5.3, §5.6–5.9, §15.4; decisions 0021–0026).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0005: devices, sessions, approvals');

-- ---------------------------------------------------------------------------------------------
-- Users: sign-in method (decision 0021), PIN block, deactivation with a reason (decision 0026)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE auth.users
  ADD COLUMN sign_in_method      text NOT NULL DEFAULT 'password'
                                 CHECK (sign_in_method IN ('pin', 'password', 'password_totp')),
  ADD COLUMN pin_must_change     boolean NOT NULL DEFAULT false,
  ADD COLUMN pin_blocked_at      timestamptz,
  ADD COLUMN deactivated_at      timestamptz,
  ADD COLUMN deactivated_by      bigint REFERENCES auth.users (id),
  ADD COLUMN deactivation_reason text;

-- PIN users have no password; everyone else has one. Hashes are always Argon2id, so a
-- plain-text secret can never be stored by mistake.
ALTER TABLE auth.users DROP CONSTRAINT users_password_ck;
ALTER TABLE auth.users
  ADD CONSTRAINT users_sign_in_ck CHECK (
    id = 1
    OR (sign_in_method = 'pin' AND pin_hash IS NOT NULL AND password_hash IS NULL)
    OR (sign_in_method IN ('password', 'password_totp') AND password_hash IS NOT NULL)),
  ADD CONSTRAINT users_hash_format_ck CHECK (
    (password_hash IS NULL OR password_hash LIKE '$argon2id$%')
    AND (pin_hash IS NULL OR pin_hash LIKE '$argon2id$%')),
  ADD CONSTRAINT users_totp_method_ck CHECK (NOT totp_enabled OR sign_in_method = 'password_totp'),
  ADD CONSTRAINT users_pin_block_ck CHECK (pin_blocked_at IS NULL OR pin_hash IS NOT NULL),
  ADD CONSTRAINT users_deactivation_ck CHECK (
    (is_active AND deactivated_at IS NULL AND deactivated_by IS NULL AND deactivation_reason IS NULL)
    OR (NOT is_active AND deactivated_at IS NOT NULL AND deactivated_by IS NOT NULL
        AND deactivation_reason IS NOT NULL AND length(btrim(deactivation_reason)) >= 3));

-- Who deactivated and when come from the request context and the server clock.
CREATE FUNCTION auth.user_deactivation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    NEW.deactivated_at := now();
    NEW.deactivated_by := sys.require_user();
  ELSIF NEW.is_active THEN
    NEW.deactivated_at := NULL;
    NEW.deactivated_by := NULL;
    NEW.deactivation_reason := NULL;
  ELSE
    NEW.deactivated_at := OLD.deactivated_at;
    NEW.deactivated_by := OLD.deactivated_by;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_user_deactivation BEFORE UPDATE ON auth.users
  FOR EACH ROW WHEN (OLD.id <> 1) EXECUTE FUNCTION auth.user_deactivation();

-- ---------------------------------------------------------------------------------------------
-- Permissions that only the owner role may hold (Settings are owner-only in the approved design)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE auth.permissions ADD COLUMN owner_only boolean NOT NULL DEFAULT false;
UPDATE auth.permissions SET owner_only = true
 WHERE code IN ('users.manage', 'users.reset_credentials', 'roles.manage', 'system.devices.manage',
                'system.settings.edit', 'system.series.manage');

-- True when an active user holds the permission through an active role.
CREATE FUNCTION auth.user_has_permission(p_user_id bigint, p_code text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM auth.users AS u
      JOIN auth.user_roles AS ur ON ur.user_id = u.id
      JOIN auth.roles AS r ON r.id = ur.role_id AND r.is_active
      JOIN auth.role_permissions AS rp ON rp.role_id = r.id AND rp.permission_code = p_code
     WHERE u.id = p_user_id AND u.is_active)
$$;

-- ---------------------------------------------------------------------------------------------
-- The owner is protected (decisions 0025, 0026): exactly one active owner, who cannot be
-- deactivated, cannot lose the role or its permissions, and always uses the 2-step code.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION auth.owner_role_id() RETURNS bigint
LANGUAGE sql STABLE AS $$ SELECT id FROM auth.roles WHERE code = 'owner' $$;

CREATE FUNCTION auth.assert_single_owner() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('artepool.auth.owner'));
  IF (SELECT count(*) FROM auth.user_roles AS ur JOIN auth.users AS u ON u.id = ur.user_id
       WHERE ur.role_id = auth.owner_role_id() AND u.is_active) > 1 THEN
    RAISE EXCEPTION 'There can be only one active owner' USING ERRCODE = 'AP008';
  END IF;
END $$;

CREATE FUNCTION auth.guard_owner_user() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  is_owner boolean := EXISTS (SELECT 1 FROM auth.user_roles
                               WHERE user_id = OLD.id AND role_id = auth.owner_role_id());
BEGIN
  IF is_owner AND OLD.is_active AND NOT NEW.is_active THEN
    RAISE EXCEPTION 'The owner account cannot be deactivated' USING ERRCODE = 'AP008';
  END IF;
  IF is_owner AND NOT OLD.is_active AND NEW.is_active THEN
    PERFORM auth.assert_single_owner();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_owner_user AFTER UPDATE OF is_active ON auth.users
  FOR EACH ROW EXECUTE FUNCTION auth.guard_owner_user();

CREATE FUNCTION auth.guard_owner_link() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role_id = auth.owner_role_id()
       AND EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id AND is_active) THEN
      RAISE EXCEPTION 'The owner role cannot be taken from the owner' USING ERRCODE = 'AP008';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.role_id = auth.owner_role_id() THEN
    PERFORM auth.assert_single_owner();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_owner_link BEFORE DELETE ON auth.user_roles
  FOR EACH ROW EXECUTE FUNCTION auth.guard_owner_link();
CREATE TRIGGER guard_owner_link_ins AFTER INSERT ON auth.user_roles
  FOR EACH ROW EXECUTE FUNCTION auth.guard_owner_link();

CREATE FUNCTION auth.guard_owner_permissions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role_id = auth.owner_role_id() THEN
      RAISE EXCEPTION 'Permissions cannot be removed from the owner role' USING ERRCODE = 'AP008';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.role_id <> auth.owner_role_id()
     AND (SELECT owner_only FROM auth.permissions WHERE code = NEW.permission_code) THEN
    RAISE EXCEPTION 'Permission % belongs to the owner only', NEW.permission_code USING ERRCODE = 'AP008';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_owner_permissions BEFORE INSERT OR DELETE ON auth.role_permissions
  FOR EACH ROW EXECUTE FUNCTION auth.guard_owner_permissions();

CREATE FUNCTION auth.guard_owner_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.code = 'owner' AND NOT NEW.requires_2fa THEN
    RAISE EXCEPTION 'The owner role always requires the 2-step code' USING ERRCODE = 'AP008';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_owner_role BEFORE UPDATE ON auth.roles
  FOR EACH ROW EXECUTE FUNCTION auth.guard_owner_role();

-- Anyone holding an active role that requires 2-step must sign in with password + 2-step code
-- (decision 0021). Checked at commit, so a user and their roles can be saved in any order.
CREATE FUNCTION auth.assert_two_step(p_user_id bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1
               FROM auth.users AS u
               JOIN auth.user_roles AS ur ON ur.user_id = u.id
               JOIN auth.roles AS r ON r.id = ur.role_id
              WHERE u.id = p_user_id AND r.requires_2fa AND r.is_active
                AND u.sign_in_method <> 'password_totp') THEN
    RAISE EXCEPTION 'User % holds a role that requires password + 2-step code sign-in', p_user_id
      USING ERRCODE = 'AP010';
  END IF;
END $$;

CREATE FUNCTION auth.check_two_step() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_user bigint;
BEGIN
  IF TG_TABLE_NAME = 'roles' THEN
    FOR v_user IN SELECT user_id FROM auth.user_roles WHERE role_id = NEW.id LOOP
      PERFORM auth.assert_two_step(v_user);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'users' THEN
    PERFORM auth.assert_two_step(NEW.id);
  ELSE
    PERFORM auth.assert_two_step(NEW.user_id);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER check_two_step AFTER INSERT OR UPDATE OF sign_in_method ON auth.users
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION auth.check_two_step();
CREATE CONSTRAINT TRIGGER check_two_step AFTER INSERT ON auth.user_roles
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION auth.check_two_step();
CREATE CONSTRAINT TRIGGER check_two_step AFTER UPDATE OF requires_2fa, is_active ON auth.roles
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION auth.check_two_step();

-- ---------------------------------------------------------------------------------------------
-- Devices: enrolled PCs only (decision 0024). Revoking is final (decision 0026).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.devices (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                  text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  name                  text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 100),
  device_kind           text NOT NULL CHECK (device_kind IN ('pos', 'office', 'warehouse', 'server')),
  branch_id             bigint NOT NULL REFERENCES sys.branches (id),
  default_warehouse_id  bigint, -- foreign key to md.warehouses is added by migration 0007
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  key_hash              bytea NOT NULL CHECK (octet_length(key_hash) = 32),
  key_expires_at        timestamptz NOT NULL,
  key_renewed_at        timestamptz,
  enrolled_at           timestamptz NOT NULL DEFAULT now(),
  enrolled_by           bigint NOT NULL REFERENCES auth.users (id),
  printer_config        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(printer_config) = 'object'),
  revoked_at            timestamptz,
  revoked_by            bigint REFERENCES auth.users (id),
  revoke_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            bigint NOT NULL REFERENCES auth.users (id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            bigint NOT NULL REFERENCES auth.users (id),
  row_version           integer NOT NULL DEFAULT 1,
  CONSTRAINT devices_key_expiry_ck CHECK (key_expires_at > enrolled_at),
  CONSTRAINT devices_revoke_ck CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL
        AND revoke_reason IS NOT NULL AND length(btrim(revoke_reason)) >= 3))
);
CREATE UNIQUE INDEX devices_key_uq ON auth.devices (key_hash);
CREATE UNIQUE INDEX devices_active_code_uq ON auth.devices (upper(code)) WHERE status = 'active';
COMMENT ON TABLE auth.devices IS
  'Enrolled PCs. Only the SHA-256 of each device key is stored. Revoked devices stay forever.';

-- Server time for enrollment, key renewal and revoke; the revoker comes from the request context.
CREATE FUNCTION auth.device_times() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.enrolled_at := now();
  ELSE
    NEW.enrolled_at := OLD.enrolled_at;
    IF NEW.key_hash IS DISTINCT FROM OLD.key_hash THEN
      NEW.key_renewed_at := now();
    END IF;
    IF NEW.status = 'revoked' AND OLD.status = 'active' THEN
      NEW.revoked_at := now();
      NEW.revoked_by := sys.require_user();
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_device_times BEFORE INSERT OR UPDATE ON auth.devices
  FOR EACH ROW EXECUTE FUNCTION auth.device_times();
SELECT sys.add_touch('auth.devices');
SELECT sys.add_immutable_guard('auth.devices', 'status', 'active', '');
SELECT audit.enable_for('auth.devices', p_redacted => ARRAY['key_hash']);
SELECT sys.forbid_delete('auth.devices');

-- Last contact from each device: technical, changes on every request, not row-audited.
CREATE TABLE auth.device_activity (
  device_id     bigint PRIMARY KEY REFERENCES auth.devices (id),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_ip       inet,
  app_version   text CHECK (length(app_version) <= 40)
);
SELECT sys.forbid_delete('auth.device_activity');

-- ---------------------------------------------------------------------------------------------
-- One-time enrollment codes (decision 0024). Only an Argon2id-derived key is stored.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.enrollment_codes (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origin           text NOT NULL CHECK (origin IN ('settings', 'console')),
  key_salt         bytea NOT NULL CHECK (octet_length(key_salt) = 16),
  code_key         bytea NOT NULL CHECK (octet_length(code_key) = 32),
  expires_at       timestamptz NOT NULL,
  failed_attempts  smallint NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  used_at          timestamptz,
  used_device_id   bigint REFERENCES auth.devices (id),
  cancelled_at     timestamptz,
  cancel_reason    text CHECK (cancel_reason IN ('replaced', 'too_many_attempts', 'cancelled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       bigint NOT NULL REFERENCES auth.users (id),
  CONSTRAINT enrollment_expiry_ck CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  CONSTRAINT enrollment_used_ck CHECK ((used_at IS NULL) = (used_device_id IS NULL)),
  CONSTRAINT enrollment_cancel_ck CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL)),
  CONSTRAINT enrollment_final_ck CHECK (used_at IS NULL OR cancelled_at IS NULL)
);
-- At most one code is open at a time; a new code first cancels the previous one.
CREATE UNIQUE INDEX enrollment_codes_open_uq ON auth.enrollment_codes ((true))
  WHERE used_at IS NULL AND cancelled_at IS NULL;

CREATE FUNCTION auth.guard_enrollment_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'This enrollment code was already used or cancelled' USING ERRCODE = 'AP003';
  END IF;
  IF NEW.used_at IS NOT NULL THEN
    IF now() >= OLD.expires_at THEN
      RAISE EXCEPTION 'This enrollment code has expired' USING ERRCODE = 'AP003';
    END IF;
    NEW.used_at := now();
  END IF;
  IF NEW.cancelled_at IS NOT NULL THEN
    NEW.cancelled_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_enrollment_code BEFORE UPDATE ON auth.enrollment_codes
  FOR EACH ROW EXECUTE FUNCTION auth.guard_enrollment_code();
SELECT sys.add_stamp('auth.enrollment_codes');
SELECT sys.add_immutable_guard('auth.enrollment_codes', '', '',
  'failed_attempts,used_at,used_device_id,cancelled_at,cancel_reason');
SELECT audit.enable_for('auth.enrollment_codes',
  p_ignored => ARRAY['failed_attempts'], p_redacted => ARRAY['code_key']);
SELECT sys.forbid_delete('auth.enrollment_codes');

-- ---------------------------------------------------------------------------------------------
-- Sessions: only the SHA-256 of the token is stored. Not row-audited: sign-in, sign-out, lock
-- and switch are explicit audit events. Ended with a reason, never deleted (decision 0026).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.sessions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash        bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  user_id           bigint NOT NULL REFERENCES auth.users (id),
  device_id         bigint NOT NULL REFERENCES auth.devices (id),
  stage             text NOT NULL CHECK (stage IN ('second_factor', 'full')),
  auth_method       text NOT NULL CHECK (auth_method IN ('password', 'password_totp',
                                                         'recovery_code', 'pin')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_activity_at  timestamptz NOT NULL DEFAULT now(),
  idle_timeout_sec  integer NOT NULL CHECK (idle_timeout_sec > 0),
  expires_at        timestamptz NOT NULL,
  locked_at         timestamptz,
  ended_at          timestamptz,
  end_reason        text CHECK (end_reason IN ('logout', 'expired', 'revoked', 'user_switch',
                                               'credential_changed', 'device_revoked',
                                               'user_deactivated', 'upgraded', 'locked_out')),
  client_ip         inet,
  CONSTRAINT sessions_expiry_ck CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
  CONSTRAINT sessions_end_ck CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CONSTRAINT sessions_stage_ck CHECK (stage = 'full' OR auth_method = 'password')
);
CREATE UNIQUE INDEX sessions_token_uq ON auth.sessions (token_hash);
CREATE INDEX sessions_open_user_ix ON auth.sessions (user_id) WHERE ended_at IS NULL;
CREATE INDEX sessions_open_device_ix ON auth.sessions (device_id) WHERE ended_at IS NULL;

-- The sign-in rules of decision 0021, enforced where no API bug can skip them.
CREATE FUNCTION auth.session_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  u auth.users;
  d auth.devices;
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
  IF NEW.auth_method IN ('password_totp', 'recovery_code') AND u.sign_in_method <> 'password_totp' THEN
    RAISE EXCEPTION 'This user does not use the 2-step code' USING ERRCODE = 'AP010';
  END IF;
  IF NEW.auth_method = 'password_totp' AND NOT u.totp_enabled THEN
    RAISE EXCEPTION 'The 2-step code is not set up for this user' USING ERRCODE = 'AP010';
  END IF;
  -- A password alone gives a full session only to users without an active 2-step code
  -- (password users, or 2-step users who must set it up first).
  IF NEW.auth_method = 'password' AND NEW.stage = 'full' AND u.totp_enabled THEN
    RAISE EXCEPTION 'The 2-step code is required' USING ERRCODE = 'AP010';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_session_before_insert BEFORE INSERT ON auth.sessions
  FOR EACH ROW EXECUTE FUNCTION auth.session_before_insert();

CREATE FUNCTION auth.guard_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'This session has ended' USING ERRCODE = 'AP003';
  END IF;
  IF NEW.ended_at IS NOT NULL THEN
    NEW.ended_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_session BEFORE UPDATE ON auth.sessions
  FOR EACH ROW EXECUTE FUNCTION auth.guard_session();
SELECT sys.add_immutable_guard('auth.sessions', '', '',
  'last_activity_at,locked_at,ended_at,end_reason');
SELECT sys.forbid_delete('auth.sessions');

-- ---------------------------------------------------------------------------------------------
-- Supervisor approvals: a single-use loan of a permission, for 5 minutes, from someone else
-- who holds it (architecture §5.5).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.approvals (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  permission_code  text NOT NULL REFERENCES auth.permissions (code),
  requested_by     bigint NOT NULL REFERENCES auth.users (id),
  approved_by      bigint NOT NULL REFERENCES auth.users (id),
  device_id        bigint NOT NULL REFERENCES auth.devices (id),
  reason_code_id   bigint, -- foreign key to sys.reason_codes is added by migration 0007
  reason_text      text NOT NULL CHECK (length(btrim(reason_text)) >= 3),
  context          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(context) = 'object'),
  approved_at      timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  consumed_entity  text CHECK (length(consumed_entity) <= 200),
  CONSTRAINT approvals_people_ck CHECK (approved_by <> requested_by),
  CONSTRAINT approvals_expiry_ck CHECK (
    expires_at > approved_at AND expires_at <= approved_at + interval '1 hour'),
  CONSTRAINT approvals_consumed_ck CHECK ((consumed_at IS NULL) = (consumed_entity IS NULL))
);
CREATE INDEX approvals_open_ix ON auth.approvals (requested_by) WHERE consumed_at IS NULL;

-- Who, where and when come from the request context and the server clock, not from the caller.
CREATE FUNCTION auth.approval_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.requested_by := sys.require_user();
  NEW.device_id := sys.ctx_device_id();
  IF NEW.device_id IS NULL THEN
    RAISE EXCEPTION 'An approval must be given on an enrolled device' USING ERRCODE = 'AP001';
  END IF;
  NEW.approved_at := now();
  NEW.expires_at := now() + make_interval(secs => (SELECT (value)::integer FROM sys.settings
                                                    WHERE key = 'security.approval_validity_seconds'));
  NEW.consumed_at := NULL;
  NEW.consumed_entity := NULL;
  IF NEW.approved_by = NEW.requested_by THEN
    RAISE EXCEPTION 'Nobody can approve their own request' USING ERRCODE = 'AP009';
  END IF;
  IF NOT coalesce((SELECT approvable FROM auth.permissions WHERE code = NEW.permission_code), false) THEN
    RAISE EXCEPTION 'Permission % cannot be approved by a supervisor', NEW.permission_code
      USING ERRCODE = 'AP009';
  END IF;
  IF NOT auth.user_has_permission(NEW.approved_by, NEW.permission_code) THEN
    RAISE EXCEPTION 'The approver does not hold permission %', NEW.permission_code
      USING ERRCODE = 'AP009';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_approval_before_insert BEFORE INSERT ON auth.approvals
  FOR EACH ROW EXECUTE FUNCTION auth.approval_before_insert();

-- Consumed once, before it expires, by the person who asked for it.
CREATE FUNCTION auth.guard_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This approval was already used' USING ERRCODE = 'AP009';
  END IF;
  IF now() >= OLD.expires_at THEN
    RAISE EXCEPTION 'This approval has expired' USING ERRCODE = 'AP009';
  END IF;
  IF sys.ctx_user_id() IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'Only the person who asked for this approval can use it' USING ERRCODE = 'AP009';
  END IF;
  IF NEW.consumed_at IS NOT NULL THEN
    NEW.consumed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_approval BEFORE UPDATE ON auth.approvals
  FOR EACH ROW EXECUTE FUNCTION auth.guard_approval();
SELECT sys.add_immutable_guard('auth.approvals', '', '', 'consumed_at,consumed_entity');
SELECT audit.enable_for('auth.approvals');
SELECT sys.forbid_delete('auth.approvals');

-- ---------------------------------------------------------------------------------------------
-- Owner 2-step recovery codes (decision 0022): Argon2id hashes, each used or revoked once.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.recovery_codes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES auth.users (id),
  code_hash   text NOT NULL CHECK (code_hash LIKE '$argon2id$%'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint NOT NULL REFERENCES auth.users (id),
  used_at     timestamptz,
  revoked_at  timestamptz,
  CONSTRAINT recovery_codes_final_ck CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX recovery_codes_open_ix ON auth.recovery_codes (user_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE FUNCTION auth.guard_recovery_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'This recovery code was already used or replaced' USING ERRCODE = 'AP003';
  END IF;
  IF NEW.used_at IS NOT NULL THEN
    NEW.used_at := now();
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_recovery_code BEFORE UPDATE ON auth.recovery_codes
  FOR EACH ROW EXECUTE FUNCTION auth.guard_recovery_code();
SELECT sys.add_stamp('auth.recovery_codes');
SELECT sys.add_immutable_guard('auth.recovery_codes', '', '', 'used_at,revoked_at');
SELECT audit.enable_for('auth.recovery_codes', p_redacted => ARRAY['code_hash']);
SELECT sys.forbid_delete('auth.recovery_codes');

-- ---------------------------------------------------------------------------------------------
-- Idempotency keys (§4.7): a retried save returns the first answer. Technical, not row-audited.
-- Responses that carry a one-time secret are stored without it. Only the maintenance role may
-- purge keys older than 30 days (decision 0026); nothing else is ever deleted.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sys.idempotency_keys (
  key              uuid PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES auth.users (id),
  device_id        bigint NOT NULL REFERENCES auth.devices (id),
  endpoint         text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 200),
  request_sha256   bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  response_status  smallint NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_body    jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idempotency_keys_created_ix ON sys.idempotency_keys (created_at);

CREATE FUNCTION sys.idempotency_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER a_idempotency_before_insert BEFORE INSERT ON sys.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION sys.idempotency_before_insert();
SELECT sys.add_immutable_guard('sys.idempotency_keys', '', '', '');

CREATE FUNCTION sys.guard_idempotency_purge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'artepool_maint'
     AND OLD.created_at < now() - interval '30 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Idempotency keys are only purged by maintenance after 30 days' USING ERRCODE = 'AP002';
END $$;
CREATE TRIGGER guard_no_delete BEFORE DELETE ON sys.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION sys.guard_idempotency_purge();
CREATE TRIGGER guard_no_truncate BEFORE TRUNCATE ON sys.idempotency_keys
  FOR EACH STATEMENT EXECUTE FUNCTION sys.guard_no_delete();

-- ---------------------------------------------------------------------------------------------
-- Settings: new security keys, and safe ranges for every security setting (decision 0023:
-- the minimum password length can be raised but never set below 10)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION sys.check_setting() RETURNS trigger
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
    "security.device_key_days": [30, 730]
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
CREATE TRIGGER check_setting BEFORE INSERT OR UPDATE ON sys.settings
  FOR EACH ROW EXECUTE FUNCTION sys.check_setting();

INSERT INTO sys.settings (key, value, description) VALUES
  ('security.max_failed_pins', '5', 'Wrong PINs before the PIN is blocked until the owner unblocks it (decision 0021)'),
  ('security.password_min_length', '10', 'Minimum password length; never below 10 (decision 0023)'),
  ('security.enrollment_code_minutes', '10', 'How long a device enrollment code stays valid (decision 0024)'),
  ('security.enrollment_max_attempts', '5', 'Wrong attempts before an enrollment code is cancelled (decision 0024)'),
  ('security.device_key_days', '365', 'Device keys are valid this long and renew themselves before expiry'),
  ('client.min_version', '"0.1.0"', 'Oldest desktop app version allowed to connect');

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
GRANT UPDATE (sign_in_method, pin_must_change, pin_blocked_at, deactivation_reason)
  ON auth.users TO artepool_api;
-- The rule checks run inside the API's own transactions (from triggers), so it may call them.
GRANT EXECUTE ON FUNCTION auth.user_has_permission(bigint, text), auth.owner_role_id(),
  auth.assert_single_owner(), auth.assert_two_step(bigint)
  TO artepool_api;

GRANT SELECT ON auth.devices TO artepool_api;
GRANT INSERT (code, name, device_kind, branch_id, key_hash, key_expires_at, enrolled_by, printer_config)
  ON auth.devices TO artepool_api;
GRANT UPDATE (code, name, device_kind, branch_id, key_hash, key_expires_at, printer_config, status,
              revoke_reason)
  ON auth.devices TO artepool_api;
GRANT SELECT, INSERT, UPDATE ON auth.device_activity TO artepool_api;

GRANT SELECT ON auth.enrollment_codes TO artepool_api;
GRANT INSERT (origin, key_salt, code_key, expires_at) ON auth.enrollment_codes TO artepool_api;
GRANT UPDATE (failed_attempts, used_at, used_device_id, cancelled_at, cancel_reason)
  ON auth.enrollment_codes TO artepool_api;

GRANT SELECT ON auth.sessions TO artepool_api;
GRANT INSERT (token_hash, user_id, device_id, stage, auth_method, idle_timeout_sec, expires_at, client_ip)
  ON auth.sessions TO artepool_api;
GRANT UPDATE (last_activity_at, locked_at, ended_at, end_reason) ON auth.sessions TO artepool_api;

GRANT SELECT ON auth.approvals TO artepool_api;
GRANT INSERT (permission_code, approved_by, reason_code_id, reason_text, context)
  ON auth.approvals TO artepool_api;
GRANT UPDATE (consumed_at, consumed_entity) ON auth.approvals TO artepool_api;

GRANT SELECT ON auth.recovery_codes TO artepool_api;
GRANT INSERT (user_id, code_hash) ON auth.recovery_codes TO artepool_api;
GRANT UPDATE (used_at, revoked_at) ON auth.recovery_codes TO artepool_api;

GRANT SELECT ON sys.idempotency_keys TO artepool_api;
GRANT INSERT (key, user_id, device_id, endpoint, request_sha256, response_status, response_body)
  ON sys.idempotency_keys TO artepool_api;
GRANT SELECT, DELETE ON sys.idempotency_keys TO artepool_maint;
