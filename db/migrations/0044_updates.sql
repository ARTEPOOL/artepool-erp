-- 0044_updates.sql
-- Purpose: automatic online updates (decision 0108, M6.2 part G5).
--  1. ops.update_state: one row the server PC's updater keeps up to date (the version running,
--     the newest published version with its release notes in Arabic and English, whether it is
--     downloaded and checked, why it is waiting, the result of the last update) and the install
--     window. System health shows it to the owner.
--  2. ops.update_requests: the owner's "Install now" for one version. The updater installs it at
--     once if no shift is open, after a checked backup; a request moves forward only.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0044: automatic online updates (0108)');

CREATE TABLE ops.update_state (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  current_version    text CHECK (current_version ~ '^\d+\.\d+\.\d+$'),
  checked_at         timestamptz,
  -- Why the last check did not reach the update list (no internet is normal: updates wait).
  check_error        text CHECK (length(check_error) <= 500),
  available_version  text CHECK (available_version ~ '^\d+\.\d+\.\d+$'),
  notes_ar           text CHECK (length(notes_ar) <= 4000),
  notes_en           text CHECK (length(notes_en) <= 4000),
  published_at       timestamptz,
  download_status    text NOT NULL DEFAULT 'none'
                       CHECK (download_status IN ('none', 'downloading', 'ready', 'failed')),
  -- Why a downloaded update has not been installed yet (failed_before: this version already
  -- failed and was rolled back; only the owner's "Install now" tries it again).
  waiting_reason     text CHECK (waiting_reason IN ('open_shift', 'outside_window', 'failed_before', 'installing')),
  last_result        jsonb,
  -- The night window, Asia/Dubai hours: an update starts at or after start and before end.
  window_start_hour  smallint NOT NULL DEFAULT 2 CHECK (window_start_hour BETWEEN 0 AND 23),
  window_end_hour    smallint NOT NULL DEFAULT 5 CHECK (window_end_hour BETWEEN 0 AND 23),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         bigint NOT NULL REFERENCES auth.users (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         bigint NOT NULL REFERENCES auth.users (id),
  row_version        integer NOT NULL DEFAULT 1,
  CONSTRAINT update_state_window_ck CHECK (window_start_hour <> window_end_hour)
);
COMMENT ON TABLE ops.update_state IS
  'The server PC''s updater (decision 0108): versions, release notes, download, waiting reason, last result, night window. One row.';
SELECT sys.add_touch('ops.update_state');
SELECT audit.enable_for('ops.update_state');
SELECT sys.forbid_delete('ops.update_state');
INSERT INTO ops.update_state DEFAULT VALUES;

CREATE TABLE ops.update_requests (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version        text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  error_message  text CHECK (length(error_message) <= 2000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     bigint NOT NULL REFERENCES auth.users (id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint NOT NULL REFERENCES auth.users (id),
  row_version    integer NOT NULL DEFAULT 1
);
-- One waiting or running "Install now" at a time.
CREATE UNIQUE INDEX update_requests_open_uq ON ops.update_requests ((true))
  WHERE status IN ('pending', 'running');
COMMENT ON TABLE ops.update_requests IS
  'The owner''s "Install now" (decision 0108): installed at once when no shift is open, after a checked backup.';

-- Only the owner asks; a request moves pending → running → done/failed, never back.
CREATE FUNCTION ops.update_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT auth.is_owner(sys.require_user()) THEN
      RAISE EXCEPTION 'Only the owner installs updates' USING ERRCODE = 'AP010';
    END IF;
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'A new request is pending' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT (OLD.status = 'pending' AND NEW.status IN ('running', 'failed')
             OR OLD.status = 'running' AND NEW.status IN ('done', 'failed')) THEN
    RAISE EXCEPTION 'An update request moves forward only' USING ERRCODE = 'AP003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_update_request_guard BEFORE INSERT OR UPDATE ON ops.update_requests
  FOR EACH ROW EXECUTE FUNCTION ops.update_request_guard();
SELECT sys.add_touch('ops.update_requests');
SELECT sys.add_immutable_guard('ops.update_requests', 'status', 'pending,running', '');
SELECT audit.enable_for('ops.update_requests');
SELECT sys.forbid_delete('ops.update_requests');

-- The owner's: "Install now" and the night window (System health already needs system.health.view).
INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('system.update.manage', 'system', 'تثبيت التحديثات (ثبّت دلوقتي، وقت التحديث بالليل)',
        'Install updates ("Install now", night window)', true, false, true);
INSERT INTO auth.role_permissions (role_id, permission_code)
VALUES (auth.owner_role_id(), 'system.update.manage');

-- The API shows the state and takes the owner's "Install now" and night window; the updater (as
-- the backup role, from the launcher on the server PC) keeps the state and works the requests.
GRANT SELECT ON ops.update_state, ops.update_requests TO artepool_api, artepool_backup;
GRANT UPDATE (window_start_hour, window_end_hour) ON ops.update_state TO artepool_api;
GRANT INSERT (version) ON ops.update_requests TO artepool_api;
GRANT UPDATE (current_version, checked_at, check_error, available_version, notes_ar, notes_en,
              published_at, download_status, waiting_reason, last_result)
  ON ops.update_state TO artepool_backup;
GRANT UPDATE (status, error_message) ON ops.update_requests TO artepool_backup;
