-- 0001_extensions_schemas_helpers.sql
-- Purpose: extensions, the nine application schemas, the request context, the shared rounding
-- rule, search normalisation, the Dubai business date and the generic table guards that every
-- later migration uses (docs/database-schema.md §1, §2, §14).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Functions created from here on are not executable by everyone: each one is granted explicitly.
ALTER DEFAULT PRIVILEGES FOR ROLE artepool_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Schemas (sys is created by the migration runner)
-- ---------------------------------------------------------------------------------------------
CREATE SCHEMA auth;
CREATE SCHEMA audit;
CREATE SCHEMA md;
CREATE SCHEMA inv;
CREATE SCHEMA sales;
CREATE SCHEMA cash;
CREATE SCHEMA gl;
CREATE SCHEMA ops;

COMMENT ON SCHEMA sys IS 'System settings, numbering, alerts, imports';
COMMENT ON SCHEMA auth IS 'Users, roles, permissions, devices, sessions, approvals';
COMMENT ON SCHEMA audit IS 'Tamper-evident, hash-chained audit log';
COMMENT ON SCHEMA md IS 'Master data';
COMMENT ON SCHEMA inv IS 'Inventory';
COMMENT ON SCHEMA sales IS 'Quotations, tax documents, payments';
COMMENT ON SCHEMA cash IS 'Cash registers, shifts, drawer';
COMMENT ON SCHEMA gl IS 'General ledger';
COMMENT ON SCHEMA ops IS 'Outbox, backups, integrity checks';

GRANT USAGE ON SCHEMA sys, auth, audit, md, inv, sales, cash, gl, ops
  TO artepool_api, artepool_backup, artepool_maint;
GRANT SELECT ON sys.schema_migrations TO artepool_api;

-- ---------------------------------------------------------------------------------------------
-- Request context: who is doing this, from which device, why (set once per transaction)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION sys.set_context(
  p_user_id bigint,
  p_device_id bigint DEFAULT NULL,
  p_session_id bigint DEFAULT NULL,
  p_request_id uuid DEFAULT NULL,
  p_client_ip inet DEFAULT NULL,
  p_client_time timestamptz DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_approval_id bigint DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A user is required for the request context' USING ERRCODE = 'AP001';
  END IF;
  PERFORM set_config('app.user_id', p_user_id::text, true);
  PERFORM set_config('app.device_id', coalesce(p_device_id::text, ''), true);
  PERFORM set_config('app.session_id', coalesce(p_session_id::text, ''), true);
  PERFORM set_config('app.request_id', coalesce(p_request_id::text, ''), true);
  PERFORM set_config('app.client_ip', coalesce(host(p_client_ip), ''), true);
  PERFORM set_config('app.client_time',
    coalesce(to_char(p_client_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), ''), true);
  PERFORM set_config('app.reason', coalesce(p_reason, ''), true);
  PERFORM set_config('app.approval_id', coalesce(p_approval_id::text, ''), true);
END $$;
COMMENT ON FUNCTION sys.set_context IS
  'Sets the transaction-local request context. Every audited write is refused without a user.';

CREATE FUNCTION sys.ctx_user_id() RETURNS bigint LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::bigint $$;
CREATE FUNCTION sys.ctx_device_id() RETURNS bigint LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.device_id', true), '')::bigint $$;
CREATE FUNCTION sys.ctx_session_id() RETURNS bigint LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.session_id', true), '')::bigint $$;
CREATE FUNCTION sys.ctx_request_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.request_id', true), '')::uuid $$;
CREATE FUNCTION sys.ctx_client_ip() RETURNS inet LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.client_ip', true), '')::inet $$;
CREATE FUNCTION sys.ctx_client_time() RETURNS timestamptz LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.client_time', true), '')::timestamptz $$;
CREATE FUNCTION sys.ctx_reason() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.reason', true), '') $$;
CREATE FUNCTION sys.ctx_approval_id() RETURNS bigint LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.approval_id', true), '')::bigint $$;

CREATE FUNCTION sys.require_user() RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_user bigint := sys.ctx_user_id();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No user context: the change was refused' USING ERRCODE = 'AP001';
  END IF;
  RETURN v_user;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Rounding, dates, search
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION sys.round_div(p_numerator numeric, p_denominator numeric) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  n numeric := abs(p_numerator);
  d numeric := abs(p_denominator);
  q numeric;
BEGIN
  IF p_denominator = 0 THEN
    RAISE EXCEPTION 'sys.round_div: division by zero' USING ERRCODE = '22012';
  END IF;
  IF p_numerator <> trunc(p_numerator) OR p_denominator <> trunc(p_denominator) THEN
    RAISE EXCEPTION 'sys.round_div works on whole numbers only' USING ERRCODE = '22023';
  END IF;
  q := div(n, d);
  IF (n - q * d) * 2 >= d THEN
    q := q + 1;
  END IF;
  IF (p_numerator < 0) <> (p_denominator < 0) THEN
    q := -q;
  END IF;
  RETURN q::bigint;
END $$;
COMMENT ON FUNCTION sys.round_div IS
  'Integer division rounded half away from zero: the single rounding rule (golden rule 1). '
  'Same cases as packages/shared/src/money/round.ts (db/test-vectors/rounding.json).';

CREATE FUNCTION sys.business_date(p_at timestamptz DEFAULT now()) RETURNS date
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
  $$ SELECT (p_at AT TIME ZONE 'Asia/Dubai')::date $$;
COMMENT ON FUNCTION sys.business_date IS 'The business date in Al Ain (Asia/Dubai) for a moment in time.';

CREATE FUNCTION sys.normalize_search(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
           regexp_replace(
             translate(lower(p_text),
               'أإآٱىیؤئةک٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
               'ااااييويهك01234567890123456789'),
             '[ً-ْٰـ]', '', 'g'),
           '\s+', ' ', 'g'))
$$;
COMMENT ON FUNCTION sys.normalize_search IS
  'Search key: lower case; Arabic letter variants unified (أإآٱ→ا, ىی→ي, ؤ→و, ئ→ي, ة→ه, ک→ك); '
  'diacritics and tatweel removed; Arabic-Indic digits → 0-9; spaces collapsed.';

-- ---------------------------------------------------------------------------------------------
-- Generic row triggers
-- ---------------------------------------------------------------------------------------------

-- [std] tables: created_*, updated_*, row_version (optimistic locking).
CREATE FUNCTION sys.touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.created_by := sys.require_user();
    NEW.updated_at := NEW.created_at;
    NEW.updated_by := NEW.created_by;
    NEW.row_version := 1;
  ELSE
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.updated_at := now();
    NEW.updated_by := sys.require_user();
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END $$;

-- [ins] tables: stamps who/when on insert and keeps the stamp unchanged afterwards.
-- Arguments: timestamp column (default created_at), user column (default created_by).
CREATE FUNCTION sys.stamp_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  at_col text := coalesce(TG_ARGV[0], 'created_at');
  by_col text := coalesce(TG_ARGV[1], 'created_by');
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(at_col, now(), by_col, sys.require_user()));
  ELSE
    NEW := jsonb_populate_record(NEW,
      jsonb_build_object(at_col, to_jsonb(OLD) -> at_col, by_col, to_jsonb(OLD) -> by_col));
  END IF;
  RETURN NEW;
END $$;

-- Business records are never deleted (golden rule 2). Also used for TRUNCATE.
CREATE FUNCTION sys.guard_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Records in %.% can never be deleted; cancel or deactivate them instead',
    TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'AP002';
END $$;

-- Final records cannot change (golden rule 3).
-- Arguments: status column ('' = always final), comma list of statuses that are still editable,
-- comma list of columns that may still change once final.
CREATE FUNCTION sys.guard_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  status_col text := nullif(TG_ARGV[0], '');
  editable text[] := coalesce(string_to_array(nullif(TG_ARGV[1], ''), ','), '{}');
  allowed text[] := coalesce(string_to_array(nullif(TG_ARGV[2], ''), ','), '{}')
                    || ARRAY['updated_at', 'updated_by', 'row_version'];
  old_row jsonb := to_jsonb(OLD);
BEGIN
  IF status_col IS NOT NULL AND (old_row ->> status_col) = ANY (editable) THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (old_row - allowed) THEN
    RAISE EXCEPTION 'This record in %.% is final and cannot be changed', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'AP003';
  END IF;
  RETURN NEW;
END $$;

-- Document lines change only while their document is a draft.
-- Arguments: parent table, foreign key column, parent status column, comma list of draft statuses.
CREATE FUNCTION sys.guard_draft_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent text := TG_ARGV[0];
  fk_col text := TG_ARGV[1];
  status_col text := TG_ARGV[2];
  draft_values text[] := string_to_array(TG_ARGV[3], ',');
  parent_ids bigint[] := '{}';
  parent_id bigint;
  parent_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    parent_ids := parent_ids || (to_jsonb(OLD) ->> fk_col)::bigint;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    parent_ids := parent_ids || (to_jsonb(NEW) ->> fk_col)::bigint;
  END IF;
  FOREACH parent_id IN ARRAY parent_ids LOOP
    EXECUTE format('SELECT %I::text FROM %s WHERE id = $1 FOR SHARE', status_col, parent)
      INTO parent_status USING parent_id;
    IF parent_status IS NULL OR NOT (parent_status = ANY (draft_values)) THEN
      RAISE EXCEPTION 'Lines can only change while the document is a draft' USING ERRCODE = 'AP006';
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Helpers for later migrations (owner only)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION sys.add_touch(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER a_touch_row BEFORE INSERT OR UPDATE ON %s '
                 'FOR EACH ROW EXECUTE FUNCTION sys.touch_row()', p_table);
END $$;

CREATE FUNCTION sys.add_stamp(p_table regclass, p_at_col text DEFAULT 'created_at',
                              p_by_col text DEFAULT 'created_by') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER a_stamp_row BEFORE INSERT OR UPDATE ON %s '
                 'FOR EACH ROW EXECUTE FUNCTION sys.stamp_row(%L, %L)', p_table, p_at_col, p_by_col);
END $$;

-- Forbids DELETE (unless p_allow_delete) and TRUNCATE on a table.
CREATE FUNCTION sys.forbid_delete(p_table regclass, p_allow_delete boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT p_allow_delete THEN
    EXECUTE format('CREATE TRIGGER guard_no_delete BEFORE DELETE ON %s '
                   'FOR EACH ROW EXECUTE FUNCTION sys.guard_no_delete()', p_table);
  END IF;
  EXECUTE format('CREATE TRIGGER guard_no_truncate BEFORE TRUNCATE ON %s '
                 'FOR EACH STATEMENT EXECUTE FUNCTION sys.guard_no_delete()', p_table);
END $$;

CREATE FUNCTION sys.add_immutable_guard(p_table regclass, p_status_col text, p_editable text,
                                        p_allowed_cols text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER guard_immutable BEFORE UPDATE ON %s '
                 'FOR EACH ROW EXECUTE FUNCTION sys.guard_immutable(%L, %L, %L)',
                 p_table, p_status_col, p_editable, p_allowed_cols);
END $$;

-- ---------------------------------------------------------------------------------------------
-- Grants: the API may set the context and use the helper functions
-- ---------------------------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
  sys.set_context(bigint, bigint, bigint, uuid, inet, timestamptz, text, bigint),
  sys.ctx_user_id(), sys.ctx_device_id(), sys.ctx_session_id(), sys.ctx_request_id(),
  sys.ctx_client_ip(), sys.ctx_client_time(), sys.ctx_reason(), sys.ctx_approval_id(),
  sys.require_user(), sys.round_div(numeric, numeric), sys.business_date(timestamptz),
  sys.normalize_search(text)
TO artepool_api;
