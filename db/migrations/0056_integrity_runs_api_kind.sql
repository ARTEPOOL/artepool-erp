-- 0056_integrity_runs_api_kind.sql
-- Purpose: the security review (M7): the API writes only reconciliation reports into
-- ops.integrity_runs. The nightly checks, the checks after a start and the restore tests are
-- written by the backup service (the backup role), never by the API, so a fault in the API can
-- never record a check it did not run. System health also reads only those checks (the API's
-- reconciliation rows have their own screen).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0056: the API records only reconciliation reports');

CREATE FUNCTION ops.integrity_run_writer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'artepool_api' AND NEW.run_kind <> 'reconciliation' THEN
    RAISE EXCEPTION 'The API records reconciliation reports only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_integrity_run_writer_guard BEFORE INSERT ON ops.integrity_runs
  FOR EACH ROW EXECUTE FUNCTION ops.integrity_run_writer_guard();
