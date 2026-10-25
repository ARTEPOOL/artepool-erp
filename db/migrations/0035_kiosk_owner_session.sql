-- 0035_kiosk_owner_session.sql
-- Purpose: decision 0091. (1) While the owner is signed in on a POS PC (a full session that is
-- neither locked, idle-locked, expired nor ended), that PC's kiosk lock is off; it comes back when
-- the owner signs out or locks the screen. (2) The owner code typed on the lock screen lifts the
-- lock for 15 minutes (was 5).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0035: kiosk lock off while the owner is signed in; owner code 15 minutes (decision 0091)');

-- The owner code: at most 15 minutes now.
CREATE OR REPLACE FUNCTION auth.kiosk_lock_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d auth.devices;
BEGIN
  SELECT * INTO d FROM auth.devices WHERE id = NEW.device_id;
  IF NOT auth.is_owner(sys.require_user()) THEN
    RAISE EXCEPTION 'Only the owner changes the kiosk lock' USING ERRCODE = 'AP010';
  END IF;
  IF d.id IS NULL OR d.status <> 'active' OR d.device_kind <> 'pos' THEN
    RAISE EXCEPTION 'The kiosk lock exists only on active POS PCs' USING ERRCODE = 'AP010';
  END IF;
  IF NEW.via = 'settings' AND NEW.reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required' USING ERRCODE = '23514';
  END IF;
  IF NOT NEW.lock_on AND NEW.off_until IS NOT NULL AND NEW.off_until <= now() THEN
    RAISE EXCEPTION 'The lock must be off until a later time' USING ERRCODE = '23514';
  END IF;
  IF NEW.via = 'owner_code' AND NEW.off_until > now() + interval '15 minutes' THEN
    RAISE EXCEPTION 'The owner code lifts the lock for at most 15 minutes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- The owner is signed in on this PC now: a full session, not locked, not idle past its limit,
-- not expired, not ended (the same tests the API applies to every request).
CREATE FUNCTION auth.owner_signed_in_on(p_device_id bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.sessions s
     WHERE s.device_id = p_device_id
       AND s.stage = 'full'
       AND s.ended_at IS NULL
       AND s.locked_at IS NULL
       AND s.expires_at > now()
       AND s.last_activity_at + make_interval(secs => s.idle_timeout_sec) > now()
       AND auth.is_owner(s.user_id))
$$;

-- The lock now: on unless the latest change turned it off and that time has not passed, or the
-- owner is signed in on the PC. A new column, so the function is created again.
DROP FUNCTION auth.kiosk_state(bigint);
CREATE FUNCTION auth.kiosk_state(p_device_id bigint,
                                 OUT locked boolean, OUT off_until timestamptz, OUT change_id bigint,
                                 OUT owner_signed_in boolean)
LANGUAGE sql STABLE AS $$
  SELECT NOT (switched_off OR owner_in),
         CASE WHEN switched_off AND NOT owner_in THEN c_off_until END,
         c_id,
         owner_in
    FROM (SELECT coalesce(NOT c.lock_on AND (c.off_until IS NULL OR c.off_until > now()), false)
                   AS switched_off,
                 c.off_until AS c_off_until,
                 c.id AS c_id,
                 auth.owner_signed_in_on(p_device_id) AS owner_in
            FROM (SELECT 1) one
            LEFT JOIN LATERAL (SELECT * FROM auth.kiosk_lock_changes k
                                WHERE k.device_id = p_device_id ORDER BY k.id DESC LIMIT 1) c ON true) s
$$;

GRANT EXECUTE ON FUNCTION auth.kiosk_state(bigint) TO artepool_api;
GRANT EXECUTE ON FUNCTION auth.owner_signed_in_on(bigint) TO artepool_api;
