-- 0046_update_check_now.sql
-- Purpose: the owner's "Check now" for updates (decision 0110).
--  1. ops.update_state.check_requested_at: when the owner last pressed "Check now". The server
--     PC's updater (every 5 minutes) reads the update list at once when it is newer than its
--     last check (checked_at); it still checks by itself every few hours too (0108).
--  2. Only the owner presses it (the API checks system.update.manage too); audited like the rest
--     of ops.update_state.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0046: check for updates now (0110)');

ALTER TABLE ops.update_state ADD COLUMN check_requested_at timestamptz;
COMMENT ON COLUMN ops.update_state.check_requested_at IS
  'The owner''s last "Check now" (decision 0110): the updater reads the update list at once when this is newer than checked_at.';

CREATE FUNCTION ops.update_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.check_requested_at IS DISTINCT FROM OLD.check_requested_at
     AND NOT auth.is_owner(sys.require_user()) THEN
    RAISE EXCEPTION 'Only the owner checks for updates' USING ERRCODE = 'AP010';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_update_state_guard BEFORE UPDATE ON ops.update_state
  FOR EACH ROW EXECUTE FUNCTION ops.update_state_guard();

GRANT UPDATE (check_requested_at) ON ops.update_state TO artepool_api;
