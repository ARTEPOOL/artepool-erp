-- 0012_gl_journals.sql
-- Purpose: journal entries and lines (docs/database-schema.md §11.4–11.5). Every financial event
-- posts one entry in the same transaction as the event itself (golden rule 4), through the
-- table-driven posting engine in the API (the accounts come from gl.account_mappings, never
-- hard-coded — decision 0018). The database guarantees:
--   • an entry balances (Σ debit = Σ credit = the header totals, at least two lines) at commit;
--   • a source document is never posted twice (except by an explicit reversal);
--   • nothing is dated in a closed or locked month (decision 0016);
--   • only active, postable accounts; a customer on every control-account line;
--   • entries are numbered without gaps (JV-) and never change or disappear.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0012: journal entries (decisions 0016, 0018)');

CREATE TABLE gl.journal_entries (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid                     uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  series_id                bigint NOT NULL REFERENCES sys.document_series (id),
  seq_no                   bigint NOT NULL,
  entry_number             text NOT NULL,
  entry_date               date NOT NULL,
  period_id                bigint NOT NULL REFERENCES gl.periods (id),
  source_type              text NOT NULL CHECK (source_type IN (
                             'sales_document', 'payment', 'opening_balance', 'cash_movement', 'shift_close',
                             'inventory_adjustment', 'inventory_count', 'reversal', 'manual')),
  -- The links to sales, payments, opening balances, cash movements and shifts get their foreign
  -- keys with those tables (M4, M5).
  sales_document_id        bigint,
  payment_id               bigint,
  opening_balance_id       bigint,
  cash_movement_id         bigint,
  shift_id                 bigint,
  inventory_adjustment_id  bigint REFERENCES inv.adjustments (id),
  inventory_count_id       bigint REFERENCES inv.counts (id),
  reversal_of_id           bigint UNIQUE REFERENCES gl.journal_entries (id),
  memo                     text CHECK (length(memo) <= 500),
  total_debit_fils         bigint NOT NULL,
  total_credit_fils        bigint NOT NULL,
  posted_at                timestamptz NOT NULL DEFAULT now(),
  posted_by                bigint NOT NULL REFERENCES auth.users (id),
  CONSTRAINT journal_entries_number_uq UNIQUE (series_id, seq_no),
  CONSTRAINT journal_entries_totals_ck CHECK (total_debit_fils = total_credit_fils AND total_debit_fils > 0),
  CONSTRAINT journal_entries_source_ck CHECK (
    num_nonnulls(sales_document_id, payment_id, opening_balance_id, cash_movement_id, shift_id,
                 inventory_adjustment_id, inventory_count_id, reversal_of_id)
      = CASE WHEN source_type = 'manual' THEN 0 ELSE 1 END
    AND CASE source_type
          WHEN 'sales_document' THEN sales_document_id IS NOT NULL
          WHEN 'payment' THEN payment_id IS NOT NULL
          WHEN 'opening_balance' THEN opening_balance_id IS NOT NULL
          WHEN 'cash_movement' THEN cash_movement_id IS NOT NULL
          WHEN 'shift_close' THEN shift_id IS NOT NULL
          WHEN 'inventory_adjustment' THEN inventory_adjustment_id IS NOT NULL
          WHEN 'inventory_count' THEN inventory_count_id IS NOT NULL
          WHEN 'reversal' THEN reversal_of_id IS NOT NULL
          ELSE true
        END)
);
-- A document can never be posted twice.
CREATE UNIQUE INDEX journal_entries_sales_document_uq ON gl.journal_entries (sales_document_id) WHERE source_type = 'sales_document';
CREATE UNIQUE INDEX journal_entries_payment_uq ON gl.journal_entries (payment_id) WHERE source_type = 'payment';
CREATE UNIQUE INDEX journal_entries_opening_uq ON gl.journal_entries (opening_balance_id) WHERE source_type = 'opening_balance';
CREATE UNIQUE INDEX journal_entries_cash_uq ON gl.journal_entries (cash_movement_id) WHERE source_type = 'cash_movement';
CREATE UNIQUE INDEX journal_entries_shift_uq ON gl.journal_entries (shift_id) WHERE source_type = 'shift_close';
CREATE UNIQUE INDEX journal_entries_adjustment_uq ON gl.journal_entries (inventory_adjustment_id) WHERE source_type = 'inventory_adjustment';
CREATE UNIQUE INDEX journal_entries_count_uq ON gl.journal_entries (inventory_count_id) WHERE source_type = 'inventory_count';
CREATE INDEX journal_entries_date_ix ON gl.journal_entries (entry_date, id);

CREATE TABLE gl.journal_lines (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id          bigint NOT NULL REFERENCES gl.journal_entries (id),
  line_no           smallint NOT NULL CHECK (line_no > 0),
  account_id        bigint NOT NULL REFERENCES gl.accounts (id),
  debit_fils        bigint NOT NULL DEFAULT 0 CHECK (debit_fils >= 0),
  credit_fils       bigint NOT NULL DEFAULT 0 CHECK (credit_fils >= 0),
  customer_id       bigint REFERENCES md.customers (id),
  business_line_id  bigint REFERENCES md.business_lines (id),
  vat_category_id   bigint REFERENCES md.vat_categories (id),
  memo              text CHECK (length(memo) <= 500),
  CONSTRAINT journal_lines_no_uq UNIQUE (entry_id, line_no),
  CONSTRAINT journal_lines_side_ck CHECK ((debit_fils = 0) <> (credit_fils = 0))
);
CREATE INDEX journal_lines_account_ix ON gl.journal_lines (account_id, entry_id);

-- The header: numbered without gaps, dated in an open month, posted by the current user.
CREATE FUNCTION gl.journal_entry_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_number record;
BEGIN
  NEW.period_id := gl.assert_period_open(NEW.entry_date);
  NEW.series_id := (SELECT s.id FROM sys.document_series s JOIN sys.branches b ON b.id = s.branch_id
                     WHERE s.doc_type = 'journal' AND s.is_default AND s.is_active
                     ORDER BY b.id LIMIT 1);
  SELECT * INTO v_number FROM sys.next_number(NEW.series_id);
  NEW.seq_no := v_number.seq_no;
  NEW.entry_number := v_number.formatted;
  NEW.posted_at := now();
  NEW.posted_by := sys.require_user();
  RETURN NEW;
END $$;
CREATE TRIGGER b_journal_entry BEFORE INSERT ON gl.journal_entries
  FOR EACH ROW EXECUTE FUNCTION gl.journal_entry_before_insert();

-- A line: an active, postable account; a customer on control accounts.
CREATE FUNCTION gl.journal_line_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a gl.accounts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM gl.accounts WHERE id = NEW.account_id;
  IF NOT a.is_active OR NOT a.is_postable THEN
    RAISE EXCEPTION 'Account % cannot receive postings', a.code
      USING ERRCODE = 'AP011', HINT = 'POSTING_ACCOUNT_INVALID', DETAIL = a.code;
  END IF;
  IF a.is_control AND NEW.customer_id IS NULL THEN
    RAISE EXCEPTION 'A line on control account % needs its customer', a.code
      USING ERRCODE = 'AP011', HINT = 'POSTING_CUSTOMER_REQUIRED', DETAIL = a.code;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_journal_line BEFORE INSERT ON gl.journal_lines
  FOR EACH ROW EXECUTE FUNCTION gl.journal_line_before_insert();

-- At commit: every entry touched balances, matches its header and has at least two lines.
CREATE FUNCTION gl.check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- Fired for a header (id) or for a line (entry_id).
  v_entry bigint := coalesce((to_jsonb(NEW) ->> 'entry_id')::bigint, NEW.id);
  v_debit bigint;
  v_credit bigint;
  v_lines integer;
  h gl.journal_entries%ROWTYPE;
BEGIN
  SELECT * INTO h FROM gl.journal_entries WHERE id = v_entry;
  SELECT coalesce(sum(debit_fils), 0), coalesce(sum(credit_fils), 0), count(*)
    INTO v_debit, v_credit, v_lines
    FROM gl.journal_lines WHERE entry_id = v_entry;
  IF v_lines < 2 OR v_debit <> v_credit OR v_debit <> h.total_debit_fils OR v_credit <> h.total_credit_fils THEN
    RAISE EXCEPTION 'Journal entry % does not balance (debit %, credit %, % lines)', h.entry_number, v_debit, v_credit, v_lines
      USING ERRCODE = 'AP011', HINT = 'JOURNAL_UNBALANCED';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER z_entry_balanced AFTER INSERT ON gl.journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gl.check_entry_balanced();
CREATE CONSTRAINT TRIGGER z_entry_balanced AFTER INSERT ON gl.journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gl.check_entry_balanced();

-- Append-only: never changed, never deleted (a mistake is corrected by a reversing entry).
SELECT sys.add_immutable_guard('gl.journal_entries', '', '', '');
SELECT sys.add_immutable_guard('gl.journal_lines', '', '', '');
SELECT audit.enable_for('gl.journal_entries');
SELECT audit.enable_for('gl.journal_lines');
SELECT sys.forbid_delete('gl.journal_entries');
SELECT sys.forbid_delete('gl.journal_lines');

-- An account that has received postings is in use: its type and header choice are fixed and it
-- cannot be deactivated (replaces the 0009 version; "posted" is checked first).
CREATE OR REPLACE FUNCTION gl.account_in_use(p_account_id bigint) RETURNS text
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM gl.journal_lines WHERE account_id = p_account_id) THEN
    RETURN 'posted';
  END IF;
  IF EXISTS (SELECT 1 FROM gl.account_mappings WHERE account_id = p_account_id) THEN
    RETURN 'event_link';
  END IF;
  IF EXISTS (SELECT 1 FROM md.business_lines
              WHERE p_account_id IN (revenue_account_id, cogs_account_id) AND is_active) THEN
    RETURN 'business_line';
  END IF;
  IF EXISTS (SELECT 1 FROM md.payment_methods WHERE gl_account_id = p_account_id AND is_active) THEN
    RETURN 'payment_method';
  END IF;
  IF EXISTS (SELECT 1 FROM sys.reason_codes WHERE gl_account_id = p_account_id AND is_active) THEN
    RETURN 'reason_code';
  END IF;
  RETURN NULL;
END $$;

-- Grants: the API posts; nobody updates or deletes.
GRANT SELECT ON gl.journal_entries, gl.journal_lines TO artepool_api;
GRANT INSERT (entry_date, source_type, sales_document_id, payment_id, opening_balance_id, cash_movement_id,
              shift_id, inventory_adjustment_id, inventory_count_id, reversal_of_id, memo,
              total_debit_fils, total_credit_fils)
  ON gl.journal_entries TO artepool_api;
GRANT INSERT (entry_id, line_no, account_id, debit_fils, credit_fils, customer_id, business_line_id,
              vat_category_id, memo)
  ON gl.journal_lines TO artepool_api;
