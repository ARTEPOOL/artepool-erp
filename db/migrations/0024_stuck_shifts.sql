-- 0024_stuck_shifts.sql
-- Purpose: shifts that can no longer be closed on their own PC (decision 0069):
--   * The owner or the accountant (shifts.force_close) closes such a shift from another PC: with a
--     reason, a count of the drawer's cash and the usual closing transfer, in one transaction. The
--     over/short stays the shift's cashier's (decision 0004) and is accepted as usual (0058).
--   * A drawer moves with its PC: after the PC is enrolled again, the owner moves the old
--     enrollment's drawer (and its open shift, if any) to the new one, with a reason.
--   * A PC with an open shift on its drawer cannot be revoked (close the shift first).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0024: stuck shifts (decision 0069)');

INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('shifts.force_close', 'cash', 'إغلاق وردية معلّقة من جهاز آخر', 'Close a stuck shift from another PC',
        true, false, false);
INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT id, 'shifts.force_close' FROM auth.roles WHERE code IN ('owner', 'accountant');

-- ---------------------------------------------------------------------------------------------
-- Closing a stuck shift from another PC
-- ---------------------------------------------------------------------------------------------
ALTER TABLE cash.shifts
  ADD COLUMN force_closed_by bigint REFERENCES auth.users (id),
  ADD COLUMN force_close_reason text
    CHECK (force_close_reason IS NULL OR length(btrim(force_close_reason)) BETWEEN 3 AND 500),
  ADD CONSTRAINT shifts_force_close_ck CHECK ((force_closed_by IS NULL) = (force_close_reason IS NULL));

-- Set once, on an open shift, by someone with the permission; the database names the person.
CREATE FUNCTION cash.shift_force_close_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_user bigint := sys.require_user();
BEGIN
  IF OLD.status <> 'open' OR OLD.force_closed_by IS NOT NULL THEN
    RAISE EXCEPTION 'Only an open shift is closed from another PC, once' USING ERRCODE = 'AP011', HINT = 'SHIFT_NOT_OPEN';
  END IF;
  IF NOT auth.user_has_permission(v_user, 'shifts.force_close') THEN
    RAISE EXCEPTION 'Closing a stuck shift needs its permission' USING ERRCODE = 'AP012', HINT = 'PERMISSION_DENIED';
  END IF;
  NEW.force_closed_by := v_user;
  RETURN NEW;
END $$;
CREATE TRIGGER b_shift_force_close BEFORE UPDATE OF force_closed_by, force_close_reason ON cash.shifts
  FOR EACH ROW WHEN (NEW.force_closed_by IS DISTINCT FROM OLD.force_closed_by
                     OR NEW.force_close_reason IS DISTINCT FROM OLD.force_close_reason)
  EXECUTE FUNCTION cash.shift_force_close_rules();

-- Decision 0004 still holds: only the shift's own cashier works on it, except the person closing
-- it from another PC (the count, the closing transfer and the close, in that one transaction).
CREATE OR REPLACE FUNCTION cash.assert_shift_owner(p_shift_id bigint) RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  s record;
BEGIN
  SELECT status, cashier_id, register_id, force_closed_by INTO s FROM cash.shifts WHERE id = p_shift_id;
  IF s.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'This shift is not open' USING ERRCODE = 'AP011', HINT = 'SHIFT_NOT_OPEN';
  END IF;
  IF s.force_closed_by IS NOT NULL THEN
    IF s.force_closed_by <> sys.require_user() THEN
      RAISE EXCEPTION 'This shift is being closed from another PC' USING ERRCODE = 'AP011', HINT = 'SHIFT_NOT_OPEN';
    END IF;
  ELSIF s.cashier_id <> sys.require_user() THEN
    RAISE EXCEPTION 'Only the shift''s own cashier works on it' USING ERRCODE = 'AP012', HINT = 'SHIFT_NOT_OWNER';
  END IF;
  RETURN s.register_id;
END $$;

-- ---------------------------------------------------------------------------------------------
-- A drawer moves with its PC (owner, with a reason)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION cash.register_device_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT auth.user_has_permission(sys.require_user(), 'system.devices.manage') THEN
    RAISE EXCEPTION 'Moving a drawer needs its permission' USING ERRCODE = 'AP012', HINT = 'PERMISSION_DENIED';
  END IF;
  IF sys.ctx_reason() IS NULL THEN
    RAISE EXCEPTION 'Moving a drawer needs a reason' USING ERRCODE = 'AP011', HINT = 'REASON_REQUIRED';
  END IF;
  IF NEW.device_id IS NULL THEN
    -- Freeing a PC for another drawer: this one is set aside, with no open shift.
    IF NEW.is_active OR EXISTS (SELECT 1 FROM cash.shifts WHERE register_id = OLD.id AND status = 'open') THEN
      RAISE EXCEPTION 'Only an inactive drawer without an open shift leaves its PC'
        USING ERRCODE = 'AP011', HINT = 'DRAWER_MOVE_INVALID';
    END IF;
  ELSE
    -- From a revoked enrollment (or none) to an active POS PC.
    IF NOT EXISTS (SELECT 1 FROM auth.devices WHERE id = NEW.device_id AND status = 'active' AND device_kind = 'pos')
       OR EXISTS (SELECT 1 FROM auth.devices WHERE id = OLD.device_id AND status = 'active') THEN
      RAISE EXCEPTION 'A drawer moves from a revoked PC to an active POS PC'
        USING ERRCODE = 'AP011', HINT = 'DRAWER_MOVE_INVALID';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_register_device BEFORE UPDATE OF device_id ON cash.registers
  FOR EACH ROW WHEN (NEW.device_id IS DISTINCT FROM OLD.device_id)
  EXECUTE FUNCTION cash.register_device_rules();

-- ---------------------------------------------------------------------------------------------
-- A PC with an open shift on its drawer stays enrolled until the shift is closed
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION cash.device_revoke_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cash.shifts s JOIN cash.registers r ON r.id = s.register_id
              WHERE r.device_id = OLD.id AND s.status = 'open') THEN
    RAISE EXCEPTION 'Close the open shift on this PC''s drawer first'
      USING ERRCODE = 'AP011', HINT = 'DEVICE_HAS_OPEN_SHIFT';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_device_revoke BEFORE UPDATE OF status ON auth.devices
  FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status = 'revoked')
  EXECUTE FUNCTION cash.device_revoke_rules();

GRANT UPDATE (force_closed_by, force_close_reason) ON cash.shifts TO artepool_api;
