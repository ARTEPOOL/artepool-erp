-- 0036_ops_backup.sql
-- Purpose: backups (decision 0086, M6.1). The backup service (role artepool_backup) records every
-- backup, upload, external-drive copy and restore test in ops.backup_runs and every integrity
-- check in ops.integrity_runs; the owner asks for one now through ops.backup_requests. Settings for
-- the encryption key (public part only) and the reminders; the "external-drive copy due" alert;
-- the health and backup permissions become owner only (owner's choice, M6.1 plan).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0036: backups, integrity checks (decision 0086)');

-- ---------------------------------------------------------------------------------------------
-- Requests from the owner: "back up now", "upload now", "restore test", "copy to the drive"
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ops.backup_requests (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('backup_now', 'offsite_now', 'restore_test', 'offline_copy')),
  -- The external drive's folder, for offline_copy only.
  target        text CHECK (length(target) BETWEEN 2 AND 260),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  error_message text CHECK (length(error_message) <= 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint NOT NULL REFERENCES auth.users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint NOT NULL REFERENCES auth.users (id),
  row_version   integer NOT NULL DEFAULT 1,
  CONSTRAINT backup_requests_target_ck CHECK ((kind = 'offline_copy') = (target IS NOT NULL))
);
-- One waiting or running request per kind.
CREATE UNIQUE INDEX backup_requests_open_uq ON ops.backup_requests (kind)
  WHERE status IN ('pending', 'running');
COMMENT ON TABLE ops.backup_requests IS
  'The owner asks the backup service for a backup, an upload, a restore test or a drive copy now (0086).';

-- Only the owner asks; a request moves pending → running → done/failed, never back.
CREATE FUNCTION ops.backup_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT auth.is_owner(sys.require_user()) THEN
      RAISE EXCEPTION 'Only the owner asks for backups and restore tests' USING ERRCODE = 'AP010';
    END IF;
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'A new request is pending' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT (OLD.status = 'pending' AND NEW.status IN ('running', 'failed')
             OR OLD.status = 'running' AND NEW.status IN ('done', 'failed')) THEN
    RAISE EXCEPTION 'A backup request moves forward only' USING ERRCODE = 'AP003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_backup_request_guard BEFORE INSERT OR UPDATE ON ops.backup_requests
  FOR EACH ROW EXECUTE FUNCTION ops.backup_request_guard();
SELECT sys.add_touch('ops.backup_requests');
SELECT sys.add_immutable_guard('ops.backup_requests', 'status', 'pending,running', '');
SELECT audit.enable_for('ops.backup_requests');
SELECT sys.forbid_delete('ops.backup_requests');

-- ---------------------------------------------------------------------------------------------
-- Every backup, upload, drive copy and restore test
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ops.backup_runs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('wal_archive', 'base_backup', 'logical_dump',
                                                 'offsite_upload', 'offline_copy', 'restore_test')),
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  request_id       bigint REFERENCES ops.backup_requests (id),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  -- Where it went (a folder, "google_drive") and the file name: never credentials.
  target           text CHECK (length(target) <= 300),
  file_name        text CHECK (length(file_name) <= 300),
  size_bytes       bigint CHECK (size_bytes >= 0),
  sha256           bytea CHECK (length(sha256) = 32),
  encrypted        boolean NOT NULL DEFAULT false,
  -- The audit chain head when the copy was taken (also recorded in audit.anchors).
  audit_chain_seq  bigint,
  audit_chain_hash bytea,
  details          jsonb,
  error_message    text CHECK (length(error_message) <= 2000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       bigint NOT NULL REFERENCES auth.users (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       bigint NOT NULL REFERENCES auth.users (id),
  row_version      integer NOT NULL DEFAULT 1,
  CONSTRAINT backup_runs_finished_ck CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT backup_runs_error_ck CHECK (status <> 'failed' OR error_message IS NOT NULL)
);
CREATE INDEX backup_runs_kind_ix ON ops.backup_runs (kind, status, finished_at DESC);
SELECT sys.add_touch('ops.backup_runs');
SELECT sys.add_immutable_guard('ops.backup_runs', 'status', 'running', '');
SELECT audit.enable_for('ops.backup_runs');
SELECT sys.forbid_delete('ops.backup_runs');

-- ---------------------------------------------------------------------------------------------
-- Integrity checks: nightly on the live database, and on every restore test
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ops.integrity_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_kind      text NOT NULL CHECK (run_kind IN ('nightly', 'restore_test', 'manual')),
  database_name text NOT NULL CHECK (length(database_name) BETWEEN 1 AND 63),
  backup_run_id bigint REFERENCES ops.backup_runs (id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'issues', 'error')),
  -- One entry per check: { "<check>": { "ok": bool, "problems": n, "examples": [...] } }.
  results       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint NOT NULL REFERENCES auth.users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint NOT NULL REFERENCES auth.users (id),
  row_version   integer NOT NULL DEFAULT 1,
  CONSTRAINT integrity_runs_finished_ck CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX integrity_runs_ix ON ops.integrity_runs (run_kind, finished_at DESC);
SELECT sys.add_touch('ops.integrity_runs');
SELECT sys.add_immutable_guard('ops.integrity_runs', 'status', 'running', '');
SELECT audit.enable_for('ops.integrity_runs');
SELECT sys.forbid_delete('ops.integrity_runs');

-- ---------------------------------------------------------------------------------------------
-- Settings: the encryption key's public part, reminders
-- ---------------------------------------------------------------------------------------------
INSERT INTO sys.settings (key, value, description) VALUES
  ('backup.age_recipient', 'null',
   'Public key (age) that encrypts the off-site copies; the private key stays offline with the owner'),
  ('backup.offline_copy_interval_days', '7', 'Remind the owner to copy to the external drive after this many days');

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
    "backup.offline_copy_interval_days": [1, 60]
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
-- Alerts: the external-drive copy is due
-- ---------------------------------------------------------------------------------------------
ALTER TABLE sys.alerts DROP CONSTRAINT alerts_alert_type_check;
ALTER TABLE sys.alerts ADD CONSTRAINT alerts_alert_type_check CHECK (alert_type IN (
  'low_stock', 'oversell_review', 'cash_drop_due', 'cash_variance',
  'repeated_variance', 'drawer_left_open', 'backup_failed', 'backup_stale',
  'restore_test_due', 'integrity_issue', 'audit_chain_broken', 'clock_skew',
  'clock_backwards', 'period_missing',
  'kiosk_lock_off', 'kiosk_lock_on', 'kiosk_exit_attempt', 'kiosk_code_blocked',
  'offline_copy_due'));

-- ---------------------------------------------------------------------------------------------
-- Permissions: the health screen and the backup tools are the owner's
-- ---------------------------------------------------------------------------------------------
INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('system.backup.manage', 'system', 'إدارة النسخ الاحتياطي (المفتاح، Google Drive، نسخ الآن)',
        'Manage backups (key, Google Drive, back up now)', true, false, true);
DELETE FROM auth.role_permissions
 WHERE permission_code IN ('system.health.view', 'system.backup.restore_test', 'system.integrity.run')
   AND role_id <> auth.owner_role_id();
UPDATE auth.permissions SET owner_only = true
 WHERE code IN ('system.health.view', 'system.backup.restore_test', 'system.integrity.run');
INSERT INTO auth.role_permissions (role_id, permission_code)
VALUES (auth.owner_role_id(), 'system.backup.manage');

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
-- The API: reads everything; the owner's requests.
GRANT SELECT ON ops.backup_requests, ops.backup_runs, ops.integrity_runs TO artepool_api;
GRANT INSERT (kind, target) ON ops.backup_requests TO artepool_api;

-- The backup service: its own records, as the SYSTEM user (it reads everything through
-- pg_read_all_data and can never change business data).
GRANT EXECUTE ON FUNCTION
  sys.set_context(bigint, bigint, bigint, uuid, inet, timestamptz, text, bigint),
  sys.ctx_user_id(), sys.ctx_device_id(), sys.ctx_session_id(), sys.ctx_request_id(),
  sys.ctx_client_ip(), sys.ctx_client_time(), sys.ctx_reason(), sys.ctx_approval_id(),
  sys.require_user(), auth.is_owner(bigint), auth.owner_role_id()
TO artepool_backup;
GRANT EXECUTE ON FUNCTION audit.verify_chain(bigint, bigint) TO artepool_backup;
GRANT UPDATE (status, error_message) ON ops.backup_requests TO artepool_backup;
GRANT INSERT (kind, status, request_id, started_at, finished_at, target, file_name, size_bytes, sha256,
              encrypted, audit_chain_seq, audit_chain_hash, details, error_message)
  ON ops.backup_runs TO artepool_backup;
GRANT UPDATE (status, finished_at, target, file_name, size_bytes, sha256, encrypted,
              audit_chain_seq, audit_chain_hash, details, error_message)
  ON ops.backup_runs TO artepool_backup;
GRANT INSERT (run_kind, database_name, backup_run_id, started_at, finished_at, status, results)
  ON ops.integrity_runs TO artepool_backup;
GRANT UPDATE (finished_at, status, results) ON ops.integrity_runs TO artepool_backup;
