-- 0054_rehearsal_runs.sql
-- Purpose: the owner's «ابدأ البروفة» on System health (M7 part B, decision 0119).
--  1. ops.rehearsal_runs: one row per rehearsal. The owner's request (the API refuses it while a
--     shift is open, while an update is installing, with too little disk, or while another one is
--     waiting or running: one at a time is also enforced here). The server PC's updater takes it
--     (running) and starts the rehearsal program, which writes each step as it ends, a heartbeat,
--     and at the end the result (green: passed, red: failed) with the report: every step, the
--     checks of the rehearsal database and of its restored backup, the speed, and the seven-step
--     reconciliation report. A run moves forward only; a finished run never changes.
--  2. system.rehearsal: the owner's alone.
-- The rehearsal itself runs on its own throwaway database: nothing of the day is written here.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0054: the automated rehearsal (0119)');

CREATE TABLE ops.rehearsal_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Only the shop's size is started from the screen (the busy day runs in GitHub).
  size          text NOT NULL DEFAULT 'shop' CHECK (size = 'shop'),
  status        text NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested', 'running', 'passed', 'failed')),
  started_at    timestamptz,
  -- Written by the rehearsal program every half minute: a run that stops writing it was cut off.
  heartbeat_at  timestamptz,
  finished_at   timestamptz,
  -- Each step as it ends: [{step, ok, ms, detail?}].
  steps         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(steps) = 'array'),
  -- The result at the end (checks, restored checks, speed, totals, reconciliation).
  report        jsonb CHECK (report IS NULL OR jsonb_typeof(report) = 'object'),
  failure       text CHECK (length(failure) <= 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint NOT NULL REFERENCES auth.users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint NOT NULL REFERENCES auth.users (id),
  row_version   integer NOT NULL DEFAULT 1,
  CONSTRAINT rehearsal_runs_finished_ck CHECK ((status IN ('passed', 'failed')) = (finished_at IS NOT NULL)),
  CONSTRAINT rehearsal_runs_started_ck CHECK (status NOT IN ('running', 'passed') OR started_at IS NOT NULL),
  CONSTRAINT rehearsal_runs_report_ck CHECK (status <> 'passed' OR report IS NOT NULL)
);
-- One waiting or running rehearsal at a time.
CREATE UNIQUE INDEX rehearsal_runs_open_uq ON ops.rehearsal_runs ((true))
  WHERE status IN ('requested', 'running');
CREATE INDEX rehearsal_runs_created_ix ON ops.rehearsal_runs (created_at DESC);
COMMENT ON TABLE ops.rehearsal_runs IS
  'The automated rehearsal (decision 0119): the owner''s request, each step as it ends, and the green/red result with its report.';

-- Only the owner asks; a run moves requested → running → passed/failed (or requested → failed when
-- it could not start), never back.
CREATE FUNCTION ops.rehearsal_run_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT auth.is_owner(sys.require_user()) THEN
      RAISE EXCEPTION 'Only the owner starts the rehearsal' USING ERRCODE = 'AP010';
    END IF;
    IF NEW.status <> 'requested' OR NEW.started_at IS NOT NULL OR NEW.steps <> '[]'::jsonb
       OR NEW.report IS NOT NULL THEN
      RAISE EXCEPTION 'A new rehearsal is only requested' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT (OLD.status = NEW.status AND OLD.status = 'running'
             OR OLD.status = 'requested' AND NEW.status IN ('running', 'failed')
             OR OLD.status = 'running' AND NEW.status IN ('passed', 'failed')) THEN
    RAISE EXCEPTION 'A rehearsal moves forward only' USING ERRCODE = 'AP003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_rehearsal_run_guard BEFORE INSERT OR UPDATE ON ops.rehearsal_runs
  FOR EACH ROW EXECUTE FUNCTION ops.rehearsal_run_guard();
SELECT sys.add_touch('ops.rehearsal_runs');
SELECT sys.add_immutable_guard('ops.rehearsal_runs', 'status', 'requested,running', '');
-- The heartbeat alone is not audited (every half minute); every step and the result are.
SELECT audit.enable_for('ops.rehearsal_runs', p_ignored => ARRAY['heartbeat_at']);
SELECT sys.forbid_delete('ops.rehearsal_runs');

INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('system.rehearsal', 'system', 'تشغيل البروفة الآلية', 'Run the automated rehearsal',
        true, false, true);
INSERT INTO auth.role_permissions (role_id, permission_code)
VALUES (auth.owner_role_id(), 'system.rehearsal');

-- The API shows the runs and takes the owner's request; the updater and the rehearsal program
-- (as the backup role, from the launcher on the server PC) take it and write its progress.
GRANT SELECT ON ops.rehearsal_runs TO artepool_api, artepool_backup;
GRANT INSERT (size) ON ops.rehearsal_runs TO artepool_api;
GRANT UPDATE (status, started_at, heartbeat_at, finished_at, steps, report, failure)
  ON ops.rehearsal_runs TO artepool_backup;
