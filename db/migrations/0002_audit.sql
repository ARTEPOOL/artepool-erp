-- 0002_audit.sql
-- Purpose: the tamper-evident audit log (golden rule 6, docs/architecture.md §5.4,
-- docs/database-schema.md §6). Every audited write and every business event becomes a row;
-- at commit the transaction's rows are sealed into a SHA-256 hash chain.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

CREATE TABLE audit.log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_seq    bigint UNIQUE,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  tx_id        xid8 NOT NULL DEFAULT pg_current_xact_id(),
  request_id   uuid,
  user_id      bigint,
  device_id    bigint,
  session_id   bigint,
  client_ip    inet,
  client_time  timestamptz,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  old_values   jsonb,
  new_values   jsonb,
  reason       text,
  approval_id  bigint,
  prev_hash    bytea,
  row_hash     bytea UNIQUE,
  CONSTRAINT log_action_ck CHECK (
    action IN ('insert', 'update', 'delete') OR action ~ '^event:[a-z_]+(\.[a-z_]+)+$'),
  CONSTRAINT log_user_ck CHECK (user_id IS NOT NULL OR action LIKE 'event:auth.%'),
  CONSTRAINT log_sealed_ck CHECK (
    (chain_seq IS NULL AND prev_hash IS NULL AND row_hash IS NULL)
    OR (chain_seq IS NOT NULL AND prev_hash IS NOT NULL AND row_hash IS NOT NULL))
);
COMMENT ON TABLE audit.log IS
  'Append-only audit log. Rows are sealed into a hash chain at commit and can never change.';

CREATE INDEX log_occurred_at_ix ON audit.log (occurred_at);
CREATE INDEX log_entity_ix ON audit.log (entity_type, entity_id);
CREATE INDEX log_user_ix ON audit.log (user_id, occurred_at);
CREATE INDEX log_action_ix ON audit.log (action, occurred_at);
CREATE INDEX log_unsealed_ix ON audit.log (tx_id) WHERE row_hash IS NULL;

CREATE TABLE audit.chain_head (
  id               smallint PRIMARY KEY CHECK (id = 1),
  installation_id  uuid NOT NULL,
  genesis_hash     bytea NOT NULL,
  last_seq         bigint NOT NULL CHECK (last_seq >= 0),
  last_hash        bytea NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE audit.chain_head IS 'The latest sealed entry of the chain. Written only by audit.seal_transaction().';

WITH install AS (SELECT gen_random_uuid() AS id)
INSERT INTO audit.chain_head (id, installation_id, genesis_hash, last_seq, last_hash)
SELECT 1, id, g, 0, g
  FROM install, LATERAL (SELECT sha256(convert_to('ARTEPOOL-ERP-GENESIS:' || id::text, 'UTF8')) AS g) h;

CREATE TABLE audit.anchors (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_seq    bigint NOT NULL CHECK (chain_seq >= 0),
  chain_hash   bytea NOT NULL,
  anchor_kind  text NOT NULL CHECK (anchor_kind IN ('z_report', 'backup', 'daily', 'manual')),
  reference    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint NOT NULL
);
COMMENT ON TABLE audit.anchors IS
  'Copies of the chain head printed on Z reports and written into backups, so a rewritten chain is detectable.';

CREATE TABLE audit.verifications (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz NOT NULL,
  triggered_by   bigint NOT NULL,
  from_seq       bigint NOT NULL,
  to_seq         bigint NOT NULL,
  rows_checked   bigint NOT NULL,
  result         text NOT NULL CHECK (result IN ('ok', 'broken')),
  first_bad_seq  bigint,
  details        text
);

-- ---------------------------------------------------------------------------------------------
-- Hashing
-- ---------------------------------------------------------------------------------------------

-- Canonical, time-zone-independent text of one entry (jsonb text output is deterministic).
CREATE FUNCTION audit.canonical(p_seq bigint, p_row audit.log) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'seq', p_seq,
    'at', (extract(epoch FROM p_row.occurred_at) * 1000000)::bigint,
    'tx', p_row.tx_id::text,
    'request', p_row.request_id,
    'user', p_row.user_id,
    'device', p_row.device_id,
    'session', p_row.session_id,
    'ip', host(p_row.client_ip),
    'client_at', (extract(epoch FROM p_row.client_time) * 1000000)::bigint,
    'action', p_row.action,
    'entity', p_row.entity_type,
    'entity_id', p_row.entity_id,
    'old', p_row.old_values,
    'new', p_row.new_values,
    'reason', p_row.reason,
    'approval', p_row.approval_id
  )::text
$$;

CREATE FUNCTION audit.compute_hash(p_prev bytea, p_seq bigint, p_row audit.log) RETURNS bytea
LANGUAGE sql STABLE AS $$
  SELECT sha256(p_prev || convert_to(audit.canonical(p_seq, p_row), 'UTF8'))
$$;

-- ---------------------------------------------------------------------------------------------
-- Capture: one row per audited insert / update / delete
-- Arguments: ignored columns, redacted columns, key columns (comma lists).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION audit.capture_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user bigint := sys.ctx_user_id();
  v_ignored text[] := coalesce(string_to_array(nullif(TG_ARGV[0], ''), ','), '{}');
  v_redacted text[] := coalesce(string_to_array(nullif(TG_ARGV[1], ''), ','), '{}');
  v_keys text[] := coalesce(string_to_array(nullif(TG_ARGV[2], ''), ','), ARRAY['id']);
  v_bookkeeping text[] := ARRAY['updated_at', 'updated_by', 'row_version'];
  v_old jsonb;
  v_new jsonb;
  v_key_source jsonb;
  v_changed text[];
  v_entity_id text;
  k text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No user context: the change to %.% was refused', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'AP001';
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_key_source := v_new;
  ELSIF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
    v_key_source := v_old;
  ELSE
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_key_source := v_new;
    SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
      FROM jsonb_each(v_new) AS n
     WHERE n.value IS DISTINCT FROM v_old -> n.key
       AND NOT (n.key = ANY (v_ignored || v_bookkeeping));
    IF v_changed IS NULL THEN
      RETURN NULL; -- only ignored or bookkeeping columns changed
    END IF;
    SELECT jsonb_object_agg(e.key, e.value) INTO v_old FROM jsonb_each(v_old) AS e WHERE e.key = ANY (v_changed);
    SELECT jsonb_object_agg(e.key, e.value) INTO v_new FROM jsonb_each(v_new) AS e WHERE e.key = ANY (v_changed);
  END IF;

  FOREACH k IN ARRAY v_redacted LOOP
    IF v_old ? k AND v_old -> k <> 'null'::jsonb THEN
      v_old := jsonb_set(v_old, ARRAY[k], '"[redacted]"');
    END IF;
    IF v_new ? k AND v_new -> k <> 'null'::jsonb THEN
      v_new := jsonb_set(v_new, ARRAY[k], '"[redacted]"');
    END IF;
  END LOOP;

  SELECT string_agg(v_key_source ->> u.col, ':' ORDER BY u.ord) INTO v_entity_id
    FROM unnest(v_keys) WITH ORDINALITY AS u(col, ord);

  INSERT INTO audit.log (request_id, user_id, device_id, session_id, client_ip, client_time,
                         action, entity_type, entity_id, old_values, new_values, reason, approval_id)
  VALUES (sys.ctx_request_id(), v_user, sys.ctx_device_id(), sys.ctx_session_id(),
          sys.ctx_client_ip(), sys.ctx_client_time(), lower(TG_OP),
          TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_entity_id, v_old, v_new,
          sys.ctx_reason(), sys.ctx_approval_id());
  RETURN NULL;
END $$;

-- Explicit business and security events (logins, cart removals, prints, exports, …).
CREATE FUNCTION audit.record_event(
  p_event text,
  p_entity_type text DEFAULT NULL,
  p_entity_id text DEFAULT NULL,
  p_data jsonb DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user bigint := sys.ctx_user_id();
  v_id bigint;
BEGIN
  IF p_event IS NULL OR p_event !~ '^[a-z_]+(\.[a-z_]+)+$' THEN
    RAISE EXCEPTION 'Invalid audit event name: %', p_event USING ERRCODE = '22023';
  END IF;
  IF v_user IS NULL AND p_event NOT LIKE 'auth.%' THEN
    RAISE EXCEPTION 'No user context: event % was refused', p_event USING ERRCODE = 'AP001';
  END IF;
  INSERT INTO audit.log (request_id, user_id, device_id, session_id, client_ip, client_time,
                         action, entity_type, entity_id, new_values, reason, approval_id)
  VALUES (sys.ctx_request_id(), v_user, sys.ctx_device_id(), sys.ctx_session_id(),
          sys.ctx_client_ip(), sys.ctx_client_time(), 'event:' || p_event, p_entity_type,
          p_entity_id, p_data, coalesce(p_reason, sys.ctx_reason()), sys.ctx_approval_id())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Sealing at commit. A deferred trigger seals all of the transaction's rows in one go: it takes
-- the chain head lock last and holds it only until commit, so it cannot cause deadlocks.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION audit.seal_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_seq bigint;
  v_prev bytea;
  v_hash bytea;
  r audit.log;
BEGIN
  PERFORM 1 FROM audit.log WHERE id = NEW.id AND row_hash IS NULL;
  IF NOT FOUND THEN
    RETURN NULL; -- already sealed by an earlier firing in this transaction
  END IF;

  SELECT last_seq, last_hash INTO v_seq, v_prev FROM audit.chain_head WHERE id = 1 FOR UPDATE;
  PERFORM set_config('audit.sealing', 'on', true);
  FOR r IN
    SELECT * FROM audit.log WHERE tx_id = pg_current_xact_id() AND row_hash IS NULL ORDER BY id
  LOOP
    v_seq := v_seq + 1;
    v_hash := audit.compute_hash(v_prev, v_seq, r);
    UPDATE audit.log SET chain_seq = v_seq, prev_hash = v_prev, row_hash = v_hash WHERE id = r.id;
    v_prev := v_hash;
  END LOOP;
  UPDATE audit.chain_head SET last_seq = v_seq, last_hash = v_prev, updated_at = clock_timestamp()
   WHERE id = 1;
  PERFORM set_config('audit.sealing', 'off', true);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER z_seal AFTER INSERT ON audit.log
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION audit.seal_transaction();

-- The log can never change, except for sealing new rows during their own commit.
CREATE FUNCTION audit.guard_log() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('audit.sealing', true) = 'on'
     AND OLD.row_hash IS NULL AND NEW.row_hash IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['chain_seq', 'prev_hash', 'row_hash'])
         = (to_jsonb(OLD) - ARRAY['chain_seq', 'prev_hash', 'row_hash']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'The audit log can never be changed or deleted' USING ERRCODE = 'AP004';
END $$;

CREATE TRIGGER guard_log BEFORE UPDATE OR DELETE ON audit.log
  FOR EACH ROW EXECUTE FUNCTION audit.guard_log();
CREATE TRIGGER guard_log_truncate BEFORE TRUNCATE ON audit.log
  FOR EACH STATEMENT EXECUTE FUNCTION audit.guard_log();

CREATE FUNCTION audit.guard_head() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('audit.sealing', true) = 'on'
     AND NEW.installation_id = OLD.installation_id AND NEW.genesis_hash = OLD.genesis_hash
     AND NEW.last_seq >= OLD.last_seq THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'The audit chain head can only move forward while sealing' USING ERRCODE = 'AP004';
END $$;

CREATE TRIGGER guard_head BEFORE UPDATE OR DELETE ON audit.chain_head
  FOR EACH ROW EXECUTE FUNCTION audit.guard_head();
CREATE TRIGGER guard_head_truncate BEFORE TRUNCATE ON audit.chain_head
  FOR EACH STATEMENT EXECUTE FUNCTION audit.guard_head();

-- Anchors and verification records are append-only.
SELECT sys.add_immutable_guard('audit.anchors', '', '', '');
SELECT sys.forbid_delete('audit.anchors');
SELECT sys.add_immutable_guard('audit.verifications', '', '', '');
SELECT sys.forbid_delete('audit.verifications');

-- ---------------------------------------------------------------------------------------------
-- Verification and anchors
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION audit.verify_chain(p_from bigint DEFAULT 1, p_to bigint DEFAULT NULL)
RETURNS TABLE (ok boolean, checked bigint, first_bad_seq bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_head audit.chain_head;
  v_last bigint;
  v_prev bytea;
  v_expected bigint;
  v_count bigint := 0;
  r audit.log;
  a audit.anchors;
BEGIN
  SELECT * INTO v_head FROM audit.chain_head WHERE id = 1;
  v_last := coalesce(p_to, v_head.last_seq);

  IF p_from <= 1 THEN
    v_prev := v_head.genesis_hash;
    v_expected := 1;
  ELSE
    SELECT l.row_hash INTO v_prev FROM audit.log AS l WHERE l.chain_seq = p_from - 1;
    v_expected := p_from;
    IF v_prev IS NULL THEN
      RETURN QUERY SELECT false, 0::bigint, p_from - 1, format('Entry #%s is missing', p_from - 1);
      RETURN;
    END IF;
  END IF;

  FOR r IN SELECT * FROM audit.log AS l WHERE l.chain_seq BETWEEN v_expected AND v_last ORDER BY l.chain_seq LOOP
    IF r.chain_seq <> v_expected THEN
      RETURN QUERY SELECT false, v_count, v_expected,
        format('Entry #%s is missing: it was deleted after it was written', v_expected);
      RETURN;
    END IF;
    IF r.prev_hash IS DISTINCT FROM v_prev THEN
      RETURN QUERY SELECT false, v_count, r.chain_seq,
        format('Entry #%s does not link to the entry before it', r.chain_seq);
      RETURN;
    END IF;
    IF audit.compute_hash(v_prev, r.chain_seq, r) IS DISTINCT FROM r.row_hash THEN
      RETURN QUERY SELECT false, v_count, r.chain_seq,
        format('Entry #%s was changed after it was written', r.chain_seq);
      RETURN;
    END IF;
    v_prev := r.row_hash;
    v_expected := v_expected + 1;
    v_count := v_count + 1;
  END LOOP;

  IF v_expected <= v_last THEN
    RETURN QUERY SELECT false, v_count, v_expected,
      format('Entries from #%s onwards are missing', v_expected);
    RETURN;
  END IF;
  IF p_to IS NULL AND v_prev IS DISTINCT FROM v_head.last_hash THEN
    RETURN QUERY SELECT false, v_count, v_last, 'The chain head does not match the last entry'::text;
    RETURN;
  END IF;

  FOR a IN SELECT * FROM audit.anchors AS x WHERE x.chain_seq BETWEEN greatest(p_from, 1) AND v_last ORDER BY x.chain_seq LOOP
    IF (SELECT l.row_hash FROM audit.log AS l WHERE l.chain_seq = a.chain_seq) IS DISTINCT FROM a.chain_hash THEN
      RETURN QUERY SELECT false, v_count, a.chain_seq,
        format('Entry #%s no longer matches the fingerprint recorded on %s %s', a.chain_seq, a.anchor_kind, a.reference);
      RETURN;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM audit.log AS l
              WHERE l.row_hash IS NULL AND l.tx_id IS DISTINCT FROM pg_current_xact_id_if_assigned()) THEN
    RETURN QUERY SELECT false, v_count, NULL::bigint,
      'Some entries were written without being sealed into the chain'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, v_count, NULL::bigint, NULL::text;
END $$;

CREATE FUNCTION audit.verify_and_record(p_from bigint DEFAULT 1, p_to bigint DEFAULT NULL)
RETURNS audit.verifications
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_user bigint := sys.require_user();
  v_result record;
  v_row audit.verifications;
BEGIN
  SELECT * INTO v_result FROM audit.verify_chain(p_from, p_to);
  INSERT INTO audit.verifications (started_at, finished_at, triggered_by, from_seq, to_seq,
                                   rows_checked, result, first_bad_seq, details)
  VALUES (v_started, clock_timestamp(), v_user, p_from,
          coalesce(p_to, (SELECT last_seq FROM audit.chain_head WHERE id = 1)),
          v_result.checked, CASE WHEN v_result.ok THEN 'ok' ELSE 'broken' END,
          v_result.first_bad_seq, v_result.problem)
  RETURNING * INTO v_row;
  PERFORM audit.record_event('audit.verify', 'audit.verifications', v_row.id::text,
    jsonb_build_object('result', v_row.result, 'rows_checked', v_row.rows_checked,
                       'first_bad_seq', v_row.first_bad_seq));
  RETURN v_row;
END $$;

CREATE FUNCTION audit.add_anchor(p_kind text, p_reference text) RETURNS audit.anchors
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row audit.anchors;
BEGIN
  INSERT INTO audit.anchors (chain_seq, chain_hash, anchor_kind, reference, created_by)
  SELECT last_seq, last_hash, p_kind, p_reference, sys.require_user()
    FROM audit.chain_head WHERE id = 1
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Helper for later migrations: attach the audit trigger to a table (owner only).
CREATE FUNCTION audit.enable_for(p_table regclass, p_ignored text[] DEFAULT '{}',
                                 p_redacted text[] DEFAULT '{}', p_keys text[] DEFAULT '{id}')
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER z_audit AFTER INSERT OR UPDATE OR DELETE ON %s '
                 'FOR EACH ROW EXECUTE FUNCTION audit.capture_row(%L, %L, %L)',
                 p_table, array_to_string(p_ignored, ','), array_to_string(p_redacted, ','),
                 array_to_string(p_keys, ','));
END $$;

-- ---------------------------------------------------------------------------------------------
-- Grants: the API can read the log and write to it only through these functions
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON audit.log, audit.chain_head, audit.anchors, audit.verifications TO artepool_api;
GRANT EXECUTE ON FUNCTION
  audit.record_event(text, text, text, jsonb, text),
  audit.verify_chain(bigint, bigint),
  audit.verify_and_record(bigint, bigint),
  audit.add_anchor(text, text)
TO artepool_api;
GRANT EXECUTE ON FUNCTION audit.add_anchor(text, text) TO artepool_backup;
