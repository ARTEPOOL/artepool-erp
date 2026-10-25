-- 0043_setup_state_clock_guard.sql
-- Purpose: M6.2 part C (decisions 0102, 0103).
--  1. sys.setup_state: one row saying whether the first-run wizard on the server PC is not started,
--     in progress (path "new" or "restore") or complete. It only moves forward and is never
--     deleted. Every database that already has an active owner is marked complete here, so the
--     wizard never appears on it.
--  2. The clock guard: nothing can be recorded before the latest record. Every write is audited, so
--     a trigger on the audit log refuses a write whose server time is more than 2 minutes before
--     the latest audit row (CLOCK_BACKWARDS). Correcting the Windows clock fixes it. The one write
--     still allowed is the "server clock went back" alert itself, so the owner hears about it.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0043: setup state and clock guard (M6.2)');

-- ---------------------------------------------------------------------------------------------
-- 1. Setup state
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sys.setup_state (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state            text NOT NULL DEFAULT 'not_started'
                     CHECK (state IN ('not_started', 'in_progress', 'complete')),
  -- The wizard's path; empty on databases that existed before the wizard (marked complete here).
  path             text CHECK (path IN ('new', 'restore')),
  -- Names this installation in backups and logs; never changes.
  installation_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL,
  created_by       bigint NOT NULL REFERENCES auth.users (id),
  updated_at       timestamptz NOT NULL,
  updated_by       bigint NOT NULL REFERENCES auth.users (id),
  row_version      integer NOT NULL,
  CONSTRAINT setup_state_shape_ck CHECK (
    (state = 'not_started' AND path IS NULL AND started_at IS NULL AND completed_at IS NULL)
    OR (state = 'in_progress' AND path IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (state = 'complete' AND completed_at IS NOT NULL))
);
COMMENT ON TABLE sys.setup_state IS
  'The first-run wizard on the server PC (decision 0102): not started, in progress or complete. One row, forward only, never deleted.';

-- Forward only, one step at a time: not_started → in_progress → complete (a step of the wizard
-- may be repeated while in progress; nothing changes once complete). The path is chosen once; the times come from
-- the server clock; the installation ID never changes.
CREATE FUNCTION sys.setup_state_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_order constant text[] := ARRAY['not_started', 'in_progress', 'complete'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.started_at := CASE WHEN NEW.state = 'not_started' THEN NULL ELSE now() END;
    NEW.completed_at := CASE WHEN NEW.state = 'complete' THEN now() END;
    RETURN NEW;
  END IF;
  IF OLD.state = 'complete'
     OR (NEW.state <> OLD.state
         AND array_position(v_order, NEW.state) <> array_position(v_order, OLD.state) + 1) THEN
    RAISE EXCEPTION 'The first-run setup cannot go back (% to %)', OLD.state, NEW.state
      USING ERRCODE = 'AP011', HINT = 'SETUP_ALREADY_DONE';
  END IF;
  IF OLD.path IS NOT NULL AND NEW.path IS DISTINCT FROM OLD.path THEN
    RAISE EXCEPTION 'The setup path was already chosen' USING ERRCODE = 'AP003';
  END IF;
  NEW.installation_id := OLD.installation_id;
  NEW.started_at := CASE
    WHEN OLD.state = 'not_started' AND NEW.state <> 'not_started' THEN now()
    ELSE OLD.started_at END;
  NEW.completed_at := CASE
    WHEN NEW.state = 'complete' AND OLD.state <> 'complete' THEN now()
    ELSE OLD.completed_at END;
  RETURN NEW;
END $$;
CREATE TRIGGER b_setup_state_rules BEFORE INSERT OR UPDATE ON sys.setup_state
  FOR EACH ROW EXECUTE FUNCTION sys.setup_state_rules();
SELECT sys.add_touch('sys.setup_state');
SELECT audit.enable_for('sys.setup_state');
SELECT sys.forbid_delete('sys.setup_state');

-- Existing databases with an owner never see the wizard.
INSERT INTO sys.setup_state (state)
SELECT CASE WHEN EXISTS (
         SELECT 1 FROM auth.users u
           JOIN auth.user_roles ur ON ur.user_id = u.id
           JOIN auth.roles r ON r.id = ur.role_id
          WHERE r.code = 'owner' AND u.is_active)
       THEN 'complete' ELSE 'not_started' END;

GRANT SELECT ON sys.setup_state TO artepool_api;
GRANT UPDATE (state, path) ON sys.setup_state TO artepool_api;

-- ---------------------------------------------------------------------------------------------
-- 2. Clock guard
-- ---------------------------------------------------------------------------------------------
-- How far back the server clock may be from the latest record (normal drift, a time sync).
CREATE FUNCTION sys.clock_tolerance() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT interval '2 minutes' $$;

-- Before each audit row: its time (clock_timestamp(), set by the column default) may not be more
-- than the tolerance before the latest audit row. Checked once per transaction: later rows of the
-- same transaction are later still. The latest row is found through the occurred_at index.
CREATE FUNCTION sys.clock_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_latest timestamptz;
BEGIN
  -- The alert that tells the owner about it is the one write let through.
  IF NEW.entity_type = 'sys.alerts' AND NEW.action = 'insert'
     AND NEW.new_values ->> 'alert_type' = 'clock_backwards' THEN
    RETURN NEW;
  END IF;
  IF current_setting('artepool.clock_checked', true) = pg_current_xact_id()::text THEN
    RETURN NEW;
  END IF;
  SELECT max(occurred_at) INTO v_latest FROM audit.log;
  IF v_latest IS NOT NULL AND NEW.occurred_at < v_latest - sys.clock_tolerance() THEN
    RAISE EXCEPTION 'The server clock is behind the latest record (% < %): check the Windows time',
      NEW.occurred_at, v_latest
      USING ERRCODE = 'AP011', HINT = 'CLOCK_BACKWARDS';
  END IF;
  PERFORM set_config('artepool.clock_checked', pg_current_xact_id()::text, true);
  RETURN NEW;
END $$;
CREATE TRIGGER a_clock_guard BEFORE INSERT ON audit.log
  FOR EACH ROW EXECUTE FUNCTION sys.clock_guard();

-- For the server's check (alert, health screen): the server time, the latest record and whether
-- the clock is behind it.
CREATE FUNCTION sys.clock_status(OUT server_time timestamptz, OUT latest_record_at timestamptz,
                                 OUT is_behind boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT clock_timestamp(), l.latest,
         coalesce(clock_timestamp() < l.latest - sys.clock_tolerance(), false)
    FROM (SELECT max(occurred_at) AS latest FROM audit.log) l
$$;

GRANT EXECUTE ON FUNCTION sys.clock_status() TO artepool_api, artepool_backup;
