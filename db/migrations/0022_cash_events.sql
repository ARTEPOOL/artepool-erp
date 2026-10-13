-- 0022_cash_events.sql
-- Purpose: the cash drawer's events for M5 (docs/database-schema.md §10.5–10.6, decisions 0004,
-- 0006, 0056–0059):
--   * cash.movements (CV-): the opening float, paid-in / paid-out, cash drops, float top-ups and
--     the closing transfer of the counted cash to the safe. Each posts its journal entry (posting
--     map rows 16–18) in the same transaction.
--   * cash.drawer_events: every time the drawer opens, and why (a No Sale needs a reason).
--   * cash.expected_cash(): float + cash sales − cash refunds ± movements; the shift close takes
--     its expected amount, counted amount and variance from the database, never from the request.
--   * cash.variance_acceptances: the owner or the accountant accepts a closed shift's over/short,
--     which posts to Cash over/short (row 19, decision 0058).
--   * Counts get an "other amount" beside the denominations, and the 0.10 / 0.05 coins (0056).
--   * Settings for the cash-drop and repeated-variance alerts (0057, 0058); the cashier's 5%
--     discount limit (0059).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0022: cash events (decisions 0004, 0006, 0056-0059)');

-- ---------------------------------------------------------------------------------------------
-- Denominations (0056): the 0.10 and 0.05 coins, so an exact-to-the-fils total can be counted
-- ---------------------------------------------------------------------------------------------
INSERT INTO md.cash_denominations (value_fils, kind, sort_order) VALUES (10, 'coin', 12), (5, 'coin', 13);

-- ---------------------------------------------------------------------------------------------
-- Counts: an "other amount" beside the denominations (0056); the rules of who counts what
-- ---------------------------------------------------------------------------------------------
ALTER TABLE cash.counts
  ADD COLUMN other_amount_fils bigint NOT NULL DEFAULT 0 CHECK (other_amount_fils >= 0);

-- The count's total equals its lines plus the other amount, checked at commit.
CREATE OR REPLACE FUNCTION cash.count_total_matches() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_count_id bigint := coalesce((to_jsonb(NEW) ->> 'count_id')::bigint, (to_jsonb(NEW) ->> 'id')::bigint);
BEGIN
  IF (SELECT total_fils - other_amount_fils FROM cash.counts WHERE id = v_count_id)
     <> (SELECT coalesce(sum(amount_fils), 0) FROM cash.count_lines WHERE count_id = v_count_id) THEN
    RAISE EXCEPTION 'A count''s total must equal its lines' USING ERRCODE = 'AP011', HINT = 'COUNT_TOTAL';
  END IF;
  RETURN NULL;
END $$;

-- Only the shift's cashier counts, on the open shift; a recount replaces the closing count once,
-- with a supervisor's approval for the recount (0006).
CREATE FUNCTION cash.count_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cash.assert_shift_owner(NEW.shift_id);
  IF NEW.supersedes_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM cash.counts WHERE id = NEW.supersedes_id AND shift_id = NEW.shift_id
                      AND purpose = 'closing' AND supersedes_id IS NULL) THEN
      RAISE EXCEPTION 'A recount replaces the shift''s closing count' USING ERRCODE = 'AP011', HINT = 'RECOUNT_INVALID';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.approvals WHERE id = NEW.approval_id AND permission_code = 'shifts.recount') THEN
      RAISE EXCEPTION 'This approval is for something else' USING ERRCODE = 'AP012', HINT = 'APPROVAL_INVALID';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_count_rules BEFORE INSERT ON cash.counts FOR EACH ROW EXECUTE FUNCTION cash.count_rules();

-- ---------------------------------------------------------------------------------------------
-- Cash movements (CV-), append-only
-- ---------------------------------------------------------------------------------------------
CREATE TABLE cash.movements (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid            uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  series_id       bigint NOT NULL REFERENCES sys.document_series (id),
  seq_no          bigint NOT NULL,
  voucher_number  text NOT NULL,
  shift_id        bigint NOT NULL REFERENCES cash.shifts (id),
  register_id     bigint NOT NULL REFERENCES cash.registers (id),
  device_id       bigint REFERENCES auth.devices (id),
  movement_type   text NOT NULL CHECK (movement_type IN (
                    'opening_float', 'paid_in', 'paid_out', 'cash_drop', 'float_top_up', 'closing_transfer')),
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  amount_fils     bigint NOT NULL CHECK (amount_fils > 0),
  movement_date   date NOT NULL,
  reason_code_id  bigint REFERENCES sys.reason_codes (id),
  note            text CHECK (length(note) <= 500),
  counterparty    text CHECK (length(counterparty) <= 200),
  approval_id     bigint REFERENCES auth.approvals (id),
  drop_count_id   bigint REFERENCES cash.counts (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      bigint NOT NULL REFERENCES auth.users (id),
  CONSTRAINT movements_number_uq UNIQUE (series_id, seq_no),
  -- Paid-in and paid-out always say why (the reason names the account, posting map rows 16–17).
  CONSTRAINT movements_reason_ck CHECK ((movement_type IN ('paid_in', 'paid_out')) = (reason_code_id IS NOT NULL)),
  CONSTRAINT movements_drop_count_ck CHECK (drop_count_id IS NULL OR movement_type = 'cash_drop')
);
CREATE INDEX movements_shift_ix ON cash.movements (shift_id);
-- The opening float and the closing transfer happen once per shift.
CREATE UNIQUE INDEX movements_once_uq ON cash.movements (shift_id, movement_type)
  WHERE movement_type IN ('opening_float', 'closing_transfer');

CREATE FUNCTION cash.movement_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_number record;
  v_category text;
  v_user bigint := sys.require_user();
BEGIN
  -- Decision 0004: only the open shift's own cashier moves its cash.
  NEW.register_id := cash.assert_shift_owner(NEW.shift_id);
  NEW.device_id := coalesce(sys.ctx_device_id(), NEW.device_id);
  NEW.movement_date := sys.business_date();
  PERFORM gl.assert_period_open(NEW.movement_date);
  NEW.direction := CASE WHEN NEW.movement_type IN ('opening_float', 'paid_in', 'float_top_up') THEN 'in' ELSE 'out' END;

  IF NEW.reason_code_id IS NOT NULL THEN
    SELECT category INTO v_category FROM sys.reason_codes WHERE id = NEW.reason_code_id AND is_active;
    IF v_category IS DISTINCT FROM NEW.movement_type THEN
      RAISE EXCEPTION 'This reason is for something else' USING ERRCODE = 'AP011', HINT = 'REASON_INVALID';
    END IF;
  END IF;

  -- A paid-out needs the permission or a supervisor's approval for it.
  IF NEW.movement_type = 'paid_out' AND NOT auth.user_has_permission(v_user, 'cash.paid_out')
     AND NOT EXISTS (SELECT 1 FROM auth.approvals WHERE id = NEW.approval_id AND permission_code = 'cash.paid_out') THEN
    RAISE EXCEPTION 'A paid-out needs approval' USING ERRCODE = 'AP012', HINT = 'APPROVAL_REQUIRED';
  END IF;
  IF NEW.approval_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.approvals WHERE id = NEW.approval_id
       AND permission_code IN ('cash.paid_out', 'cash.paid_in', 'cash.drop')) THEN
    RAISE EXCEPTION 'This approval is for something else' USING ERRCODE = 'AP012', HINT = 'APPROVAL_INVALID';
  END IF;

  -- Money leaving the drawer can never be more than the drawer holds.
  IF NEW.direction = 'out' AND NEW.movement_type <> 'closing_transfer'
     AND NEW.amount_fils > cash.expected_cash(NEW.shift_id) THEN
    RAISE EXCEPTION 'The drawer does not hold that much cash' USING ERRCODE = 'AP011', HINT = 'DRAWER_SHORT';
  END IF;
  IF NEW.drop_count_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cash.counts WHERE id = NEW.drop_count_id
       AND shift_id = NEW.shift_id AND purpose = 'drop' AND total_fils = NEW.amount_fils) THEN
    RAISE EXCEPTION 'The drop count must be this shift''s, for the dropped amount'
      USING ERRCODE = 'AP011', HINT = 'COUNT_TOTAL';
  END IF;

  NEW.series_id := (SELECT id FROM sys.document_series WHERE doc_type = 'cash_voucher' ORDER BY id LIMIT 1);
  SELECT * INTO v_number FROM sys.next_number(NEW.series_id);
  NEW.seq_no := v_number.seq_no;
  NEW.voucher_number := v_number.formatted;
  RETURN NEW;
END $$;

/**
 * The cash a shift's drawer should hold: the opening float, cash received at the POS on this
 * shift (net of change), cash refunded from it, and the cash movements. The closing transfer is
 * left out: it empties the drawer after the count.
 */
CREATE FUNCTION cash.expected_cash(p_shift_id bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT sum(CASE WHEN p.direction = 'in' THEN p.amount_fils ELSE -p.amount_fils END)
                     FROM sales.payments p
                    WHERE p.shift_id = p_shift_id AND p.method_kind = 'cash'), 0)
       + coalesce((SELECT sum(CASE WHEN m.direction = 'in' THEN m.amount_fils ELSE -m.amount_fils END)
                     FROM cash.movements m
                    WHERE m.shift_id = p_shift_id AND m.movement_type <> 'closing_transfer'), 0)
$$;

CREATE TRIGGER b_movement_rules BEFORE INSERT ON cash.movements
  FOR EACH ROW EXECUTE FUNCTION cash.movement_rules();
SELECT sys.add_stamp('cash.movements');
SELECT audit.enable_for('cash.movements');
SELECT sys.forbid_delete('cash.movements');
SELECT sys.add_immutable_guard('cash.movements', '', '', '');

-- At commit: every movement has its journal entry (golden rule 4).
CREATE FUNCTION cash.movement_commit_checks() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gl.journal_entries WHERE source_type = 'cash_movement' AND cash_movement_id = NEW.id) THEN
    RAISE EXCEPTION 'A cash movement needs its journal entry' USING ERRCODE = 'AP011', HINT = 'JOURNAL_MISSING';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER z_movement_commit AFTER INSERT ON cash.movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash.movement_commit_checks();

-- ---------------------------------------------------------------------------------------------
-- Drawer events (append-only): every opening of the drawer and why
-- ---------------------------------------------------------------------------------------------
CREATE TABLE cash.drawer_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  register_id        bigint NOT NULL REFERENCES cash.registers (id),
  shift_id           bigint REFERENCES cash.shifts (id),
  event_type         text NOT NULL CHECK (event_type IN (
                       'open_sale', 'open_payment', 'open_cash_movement', 'open_count', 'open_no_sale',
                       'reported_open', 'reported_closed', 'left_open_alert')),
  sales_document_id  bigint REFERENCES sales.documents (id),
  payment_id         bigint REFERENCES sales.payments (id),
  cash_movement_id   bigint REFERENCES cash.movements (id),
  reason_code_id     bigint REFERENCES sys.reason_codes (id),
  note               text CHECK (length(note) <= 500),
  approval_id        bigint REFERENCES auth.approvals (id),
  user_id            bigint NOT NULL REFERENCES auth.users (id),
  device_id          bigint REFERENCES auth.devices (id),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drawer_events_no_sale_ck CHECK (event_type <> 'open_no_sale' OR reason_code_id IS NOT NULL)
);
CREATE INDEX drawer_events_shift_ix ON cash.drawer_events (shift_id);

CREATE FUNCTION cash.drawer_event_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_category text;
BEGIN
  NEW.device_id := coalesce(sys.ctx_device_id(), NEW.device_id);
  IF NEW.shift_id IS NOT NULL THEN
    NEW.register_id := cash.assert_shift_owner(NEW.shift_id);
  END IF;
  IF NEW.event_type = 'open_no_sale' THEN
    SELECT category INTO v_category FROM sys.reason_codes WHERE id = NEW.reason_code_id AND is_active;
    IF v_category IS DISTINCT FROM 'no_sale' THEN
      RAISE EXCEPTION 'This reason is for something else' USING ERRCODE = 'AP011', HINT = 'REASON_INVALID';
    END IF;
    IF NEW.shift_id IS NULL THEN
      RAISE EXCEPTION 'The drawer opens without a sale only on an open shift' USING ERRCODE = 'AP011', HINT = 'SHIFT_NOT_OPEN';
    END IF;
    IF NOT auth.user_has_permission(NEW.user_id, 'pos.no_sale') THEN
      RAISE EXCEPTION 'Opening the drawer without a sale needs its permission' USING ERRCODE = 'AP012', HINT = 'PERMISSION_DENIED';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Stamped first (a_), so the user is the signed-in person before the rules check them.
SELECT sys.add_stamp('cash.drawer_events', 'occurred_at', 'user_id');
CREATE TRIGGER b_drawer_event_rules BEFORE INSERT ON cash.drawer_events
  FOR EACH ROW EXECUTE FUNCTION cash.drawer_event_rules();
SELECT audit.enable_for('cash.drawer_events');
SELECT sys.forbid_delete('cash.drawer_events');
SELECT sys.add_immutable_guard('cash.drawer_events', '', '', '');

-- ---------------------------------------------------------------------------------------------
-- The shift close: expected, counted and variance come from the database
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION cash.shift_close_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_count record;
BEGIN
  PERFORM cash.assert_shift_owner(OLD.id);
  -- The final count is the recount when there is one, else the closing count.
  SELECT id, total_fils INTO v_count FROM cash.counts
   WHERE shift_id = OLD.id AND purpose = 'closing'
   ORDER BY (supersedes_id IS NOT NULL) DESC LIMIT 1;
  IF v_count.id IS NULL THEN
    RAISE EXCEPTION 'A shift closes after its cash is counted' USING ERRCODE = 'AP011', HINT = 'COUNT_MISSING';
  END IF;
  NEW.closing_count_id := v_count.id;
  NEW.counted_cash_fils := v_count.total_fils;
  NEW.expected_cash_fils := cash.expected_cash(OLD.id);
  NEW.variance_fils := NEW.counted_cash_fils - NEW.expected_cash_fils;
  -- The counted cash leaves the drawer for the safe (posting map row 18), in this transaction.
  IF NEW.counted_cash_fils > 0 AND NOT EXISTS (SELECT 1 FROM cash.movements
       WHERE shift_id = OLD.id AND movement_type = 'closing_transfer' AND amount_fils = NEW.counted_cash_fils) THEN
    RAISE EXCEPTION 'The counted cash must go to the safe' USING ERRCODE = 'AP011', HINT = 'CLOSING_TRANSFER';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c_shift_close_rules BEFORE UPDATE OF status ON cash.shifts
  FOR EACH ROW WHEN (OLD.status = 'open' AND NEW.status = 'closed') EXECUTE FUNCTION cash.shift_close_rules();

-- The opening float is a movement from the safe (row 18), in the opening transaction.
CREATE FUNCTION cash.shift_open_checks() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.opening_float_fils > 0 AND NOT EXISTS (SELECT 1 FROM cash.movements
       WHERE shift_id = NEW.id AND movement_type = 'opening_float' AND amount_fils = NEW.opening_float_fils) THEN
    RAISE EXCEPTION 'The opening float must come from the safe' USING ERRCODE = 'AP011', HINT = 'OPENING_FLOAT';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER z_shift_open AFTER INSERT ON cash.shifts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash.shift_open_checks();

-- ---------------------------------------------------------------------------------------------
-- Variance acceptance (0058): the owner or the accountant, once per closed shift
-- ---------------------------------------------------------------------------------------------
CREATE TABLE cash.variance_acceptances (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id        bigint NOT NULL UNIQUE REFERENCES cash.shifts (id),
  variance_fils   bigint NOT NULL,
  reason_code_id  bigint REFERENCES sys.reason_codes (id),
  note            text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 3 AND 1000),
  accepted_at     timestamptz NOT NULL DEFAULT now(),
  accepted_by     bigint NOT NULL REFERENCES auth.users (id)
);

CREATE FUNCTION cash.variance_acceptance_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s record;
BEGIN
  SELECT status, variance_fils, cashier_id INTO s FROM cash.shifts WHERE id = NEW.shift_id;
  IF s.status IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'Only a closed shift''s variance is accepted' USING ERRCODE = 'AP011', HINT = 'SHIFT_NOT_CLOSED';
  END IF;
  IF NOT auth.user_has_permission(NEW.accepted_by, 'cash.variance_accept') THEN
    RAISE EXCEPTION 'Accepting a variance needs its permission' USING ERRCODE = 'AP012', HINT = 'PERMISSION_DENIED';
  END IF;
  IF NEW.accepted_by = s.cashier_id THEN
    RAISE EXCEPTION 'A cashier never accepts their own variance' USING ERRCODE = 'AP012', HINT = 'OWN_VARIANCE';
  END IF;
  NEW.variance_fils := s.variance_fils;
  PERFORM gl.assert_period_open(sys.business_date());
  RETURN NEW;
END $$;
SELECT sys.add_stamp('cash.variance_acceptances', 'accepted_at', 'accepted_by');
CREATE TRIGGER b_variance_acceptance_rules BEFORE INSERT ON cash.variance_acceptances
  FOR EACH ROW EXECUTE FUNCTION cash.variance_acceptance_rules();
SELECT audit.enable_for('cash.variance_acceptances');
SELECT sys.forbid_delete('cash.variance_acceptances');
SELECT sys.add_immutable_guard('cash.variance_acceptances', '', '', '');

-- At commit: an accepted non-zero variance has its journal entry (row 19).
CREATE FUNCTION cash.variance_commit_checks() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.variance_fils <> 0 AND NOT EXISTS (SELECT 1 FROM gl.journal_entries
       WHERE source_type = 'shift_close' AND shift_id = NEW.shift_id) THEN
    RAISE EXCEPTION 'An accepted variance needs its journal entry' USING ERRCODE = 'AP011', HINT = 'JOURNAL_MISSING';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER z_variance_commit AFTER INSERT ON cash.variance_acceptances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cash.variance_commit_checks();

-- ---------------------------------------------------------------------------------------------
-- Journal links (rows 16–19): one entry per movement, one per accepted variance
-- ---------------------------------------------------------------------------------------------
ALTER TABLE gl.journal_entries
  ADD CONSTRAINT journal_entries_cash_movement_fk FOREIGN KEY (cash_movement_id) REFERENCES cash.movements (id),
  ADD CONSTRAINT journal_entries_shift_fk FOREIGN KEY (shift_id) REFERENCES cash.shifts (id);
CREATE UNIQUE INDEX journal_entries_cash_movement_uq ON gl.journal_entries (cash_movement_id) WHERE source_type = 'cash_movement';
CREATE UNIQUE INDEX journal_entries_shift_close_uq ON gl.journal_entries (shift_id) WHERE source_type = 'shift_close';

-- ---------------------------------------------------------------------------------------------
-- Settings (0057, 0058) and the cashier's discount limit (0059)
-- ---------------------------------------------------------------------------------------------
INSERT INTO sys.settings (key, value, description) VALUES
  ('cash.drop_alert_fils', '300000', 'Alert when a drawer holds more cash than this, in fils (decision 0057)'),
  ('cash.variance_alert_fils', '2000', 'A shift variance above this, in fils, counts toward the repeated-variance alert (decision 0058)'),
  ('cash.variance_alert_days', '30', 'Days looked back for the repeated-variance alert (decision 0058)');
UPDATE sys.settings
   SET description = 'Variances above cash.variance_alert_fils within cash.variance_alert_days that raise an alert (decision 0058)'
 WHERE key = 'cash.variance_alert_repeat_count';

-- A cashier may discount up to 5% (no amount cap besides the percentage); above it a supervisor approves.
UPDATE auth.roles SET max_discount_bp = 500, max_discount_fils = 9223372036854775807 WHERE code = 'cashier';

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON cash.movements, cash.drawer_events, cash.variance_acceptances TO artepool_api;
GRANT INSERT (other_amount_fils) ON cash.counts TO artepool_api;
GRANT INSERT (shift_id, movement_type, amount_fils, reason_code_id, note, counterparty, approval_id, drop_count_id)
  ON cash.movements TO artepool_api;
GRANT INSERT (register_id, shift_id, event_type, sales_document_id, payment_id, cash_movement_id, reason_code_id,
              note, approval_id)
  ON cash.drawer_events TO artepool_api;
GRANT INSERT (shift_id, reason_code_id, note) ON cash.variance_acceptances TO artepool_api;
GRANT EXECUTE ON FUNCTION cash.expected_cash(bigint) TO artepool_api;
