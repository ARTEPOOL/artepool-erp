-- 0016_outbox_print.sql
-- Purpose: the e-invoice outbox (docs/database-schema.md §12.1, decision 0019) and versioned print
-- templates (§4.10–4.11, decisions 0020 and 0050).
--   * Every issued tax document gets an outbox row in the same transaction: 'not_required' before
--     the go-live date in einvoice.mandatory_from (still pending from the accountant), 'pending'
--     from it. Nothing is sent in Phase 1 until the provider is chosen.
--   * Every issued document and sent quotation keeps the template version it was printed with,
--     so a reprint always looks like the original. M4 uses one default version per document kind;
--     the owner's designer screen comes in M4b.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0016: outbox and print templates (decisions 0019, 0020, 0050)');

-- ---------------------------------------------------------------------------------------------
-- Print templates and their versions
-- ---------------------------------------------------------------------------------------------
INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('print_templates.manage', 'system', 'تصميم قوالب الطباعة', 'Design print templates', true, false, true);
INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT id, 'print_templates.manage' FROM auth.roles WHERE code = 'owner';

CREATE TABLE sys.print_templates (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_kind            text NOT NULL UNIQUE CHECK (doc_kind IN
                        ('tax_invoice_a4', 'quotation_a4', 'credit_note_a4', 'receipt_a4', 'statement_a4',
                         'receipt_thermal', 'z_report', 'barcode_label')),
  current_version_id  bigint,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          bigint NOT NULL REFERENCES auth.users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          bigint NOT NULL REFERENCES auth.users (id),
  row_version         integer NOT NULL DEFAULT 1
);
SELECT sys.add_touch('sys.print_templates');
SELECT audit.enable_for('sys.print_templates');
SELECT sys.forbid_delete('sys.print_templates');

CREATE TABLE sys.print_template_versions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id  bigint NOT NULL REFERENCES sys.print_templates (id),
  version_no   integer NOT NULL CHECK (version_no > 0),
  settings     jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  logo_sha256  bytea CHECK (logo_sha256 IS NULL OR octet_length(logo_sha256) = 32),
  note         text CHECK (length(note) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint NOT NULL REFERENCES auth.users (id),
  CONSTRAINT print_template_versions_uq UNIQUE (template_id, version_no)
);
ALTER TABLE sys.print_templates
  ADD CONSTRAINT print_templates_current_fk FOREIGN KEY (current_version_id) REFERENCES sys.print_template_versions (id);

-- A new version is the next number of its template, saved only by the owner; never changed later.
CREATE FUNCTION sys.print_version_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF sys.require_user() <> 1 AND NOT auth.user_has_permission(sys.require_user(), 'print_templates.manage') THEN
    RAISE EXCEPTION 'Only the owner designs print templates' USING ERRCODE = 'AP012', HINT = 'PRINT_OWNER_ONLY';
  END IF;
  PERFORM 1 FROM sys.print_templates WHERE id = NEW.template_id FOR UPDATE;
  NEW.version_no := coalesce((SELECT max(version_no) FROM sys.print_template_versions
                               WHERE template_id = NEW.template_id), 0) + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER b_print_version_rules BEFORE INSERT ON sys.print_template_versions
  FOR EACH ROW EXECUTE FUNCTION sys.print_version_rules();
SELECT sys.add_stamp('sys.print_template_versions');
SELECT audit.enable_for('sys.print_template_versions');
SELECT sys.forbid_delete('sys.print_template_versions');
SELECT sys.add_immutable_guard('sys.print_template_versions', '', '', '');

-- The default design of each kind (design 09): both languages, the company logo, standard texts.
INSERT INTO sys.print_templates (doc_kind)
VALUES ('tax_invoice_a4'), ('quotation_a4'), ('credit_note_a4'), ('receipt_a4'), ('statement_a4'),
       ('receipt_thermal'), ('z_report'), ('barcode_label');
INSERT INTO sys.print_template_versions (template_id, settings, note)
SELECT id, jsonb_build_object(
         'language', 'both', 'showLogo', true, 'logoPosition', 'start', 'logoSizeMm', 28, 'textSize', 'normal',
         'marginsMm', jsonb_build_object('top', 12, 'bottom', 12, 'start', 12, 'end', 12),
         'paperWidthMm', CASE doc_kind WHEN 'receipt_thermal' THEN 80 END,
         'optional', jsonb_build_object('salesperson', true, 'dueDate', true, 'customerPhone', true,
                                        'lineDiscount', true, 'notes', true, 'bankDetails', false),
         'texts', jsonb_build_object('welcomeAr', '', 'welcomeEn', '', 'termsAr', '', 'termsEn', '',
                                     'footerAr', 'شكرًا لتعاملكم معنا', 'footerEn', 'Thank you for your business')),
       'Default design (decision 0050)'
  FROM sys.print_templates;
UPDATE sys.print_templates t
   SET current_version_id = (SELECT id FROM sys.print_template_versions v WHERE v.template_id = t.id);

/** The current template version for a kind of printed document. */
CREATE FUNCTION sys.current_print_version(p_doc_kind text) RETURNS bigint
LANGUAGE sql STABLE AS $$ SELECT current_version_id FROM sys.print_templates WHERE doc_kind = p_doc_kind $$;

-- ---------------------------------------------------------------------------------------------
-- Documents and quotations keep their template version
-- ---------------------------------------------------------------------------------------------
ALTER TABLE sales.documents ADD COLUMN print_template_version_id bigint REFERENCES sys.print_template_versions (id);
ALTER TABLE sales.documents ADD CONSTRAINT documents_print_version_ck
  CHECK (status <> 'issued' OR print_template_version_id IS NOT NULL);
ALTER TABLE sales.quotations ADD COLUMN print_template_version_id bigint REFERENCES sys.print_template_versions (id);
ALTER TABLE sales.quotations ADD CONSTRAINT quotations_print_version_ck
  CHECK (status = 'draft' OR print_template_version_id IS NOT NULL);
ALTER TABLE sales.payments ADD COLUMN print_template_version_id bigint REFERENCES sys.print_template_versions (id);

CREATE FUNCTION sales.stamp_print_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'documents' THEN
    IF NEW.status = 'issued' AND OLD.status = 'draft' THEN
      NEW.print_template_version_id := sys.current_print_version(CASE
        WHEN NEW.channel = 'pos' THEN 'receipt_thermal'
        WHEN NEW.doc_type = 'credit_note' THEN 'credit_note_a4'
        ELSE 'tax_invoice_a4' END);
    END IF;
  ELSIF TG_TABLE_NAME = 'quotations' THEN
    IF NEW.status = 'sent' AND OLD.status = 'draft' THEN
      NEW.print_template_version_id := sys.current_print_version('quotation_a4');
    END IF;
  ELSE
    NEW.print_template_version_id := sys.current_print_version(
      CASE WHEN NEW.channel = 'pos' THEN 'receipt_thermal' ELSE 'receipt_a4' END);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c_stamp_print_version BEFORE UPDATE OF status ON sales.documents
  FOR EACH ROW EXECUTE FUNCTION sales.stamp_print_version();
CREATE TRIGGER c_stamp_print_version BEFORE UPDATE OF status ON sales.quotations
  FOR EACH ROW EXECUTE FUNCTION sales.stamp_print_version();
CREATE TRIGGER c_stamp_print_version BEFORE INSERT ON sales.payments
  FOR EACH ROW EXECUTE FUNCTION sales.stamp_print_version();

-- ---------------------------------------------------------------------------------------------
-- The e-invoice outbox (decision 0019)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE ops.outbox (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid                uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  channel             text NOT NULL CHECK (channel IN ('einvoice', 'email', 'whatsapp')),
  sales_document_id   bigint REFERENCES sales.documents (id),
  status              text NOT NULL CHECK (status IN
                        ('not_required', 'pending', 'sending', 'sent', 'accepted', 'rejected', 'failed', 'cancelled')),
  payload_format      text CHECK (length(payload_format) <= 50),
  payload             jsonb,
  payload_sha256      bytea CHECK (payload_sha256 IS NULL OR octet_length(payload_sha256) = 32),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at     timestamptz,
  last_attempt_at     timestamptz,
  last_error          text CHECK (length(last_error) <= 4000),
  provider_reference  text CHECK (length(provider_reference) <= 200),
  response            jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          bigint NOT NULL REFERENCES auth.users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          bigint NOT NULL REFERENCES auth.users (id),
  row_version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX outbox_einvoice_uq ON ops.outbox (sales_document_id) WHERE channel = 'einvoice';
CREATE INDEX outbox_pending_ix ON ops.outbox (next_attempt_at) WHERE status IN ('pending', 'failed');

-- The payload never changes once set.
CREATE FUNCTION ops.outbox_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.payload IS NOT NULL AND (NEW.payload IS DISTINCT FROM OLD.payload
                                  OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256) THEN
    RAISE EXCEPTION 'An outbox payload never changes once set' USING ERRCODE = 'AP003';
  END IF;
  IF NEW.sales_document_id IS DISTINCT FROM OLD.sales_document_id OR NEW.channel IS DISTINCT FROM OLD.channel THEN
    RAISE EXCEPTION 'An outbox row stays with its document' USING ERRCODE = 'AP003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_outbox_rules BEFORE UPDATE ON ops.outbox FOR EACH ROW EXECUTE FUNCTION ops.outbox_rules();
SELECT sys.add_touch('ops.outbox');
SELECT audit.enable_for('ops.outbox');
SELECT sys.forbid_delete('ops.outbox');

-- Every issued tax document is queued in the same transaction.
CREATE FUNCTION ops.queue_einvoice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_from date := (SELECT (value #>> '{}')::date FROM sys.settings WHERE key = 'einvoice.mandatory_from');
BEGIN
  INSERT INTO ops.outbox (channel, sales_document_id, status, next_attempt_at)
  VALUES ('einvoice', NEW.id,
          CASE WHEN v_from IS NOT NULL AND NEW.issue_date >= v_from THEN 'pending' ELSE 'not_required' END,
          CASE WHEN v_from IS NOT NULL AND NEW.issue_date >= v_from THEN now() END);
  RETURN NULL;
END $$;
CREATE TRIGGER z_queue_einvoice AFTER UPDATE OF status ON sales.documents
  FOR EACH ROW WHEN (NEW.status = 'issued' AND OLD.status = 'draft') EXECUTE FUNCTION ops.queue_einvoice();

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON sys.print_templates, sys.print_template_versions, ops.outbox TO artepool_api;
GRANT INSERT (template_id, settings, logo_sha256, note) ON sys.print_template_versions TO artepool_api;
GRANT UPDATE (current_version_id) ON sys.print_templates TO artepool_api;
GRANT UPDATE (status, payload_format, payload, payload_sha256, attempts, next_attempt_at, last_attempt_at,
              last_error, provider_reference, response)
  ON ops.outbox TO artepool_api;
GRANT EXECUTE ON FUNCTION sys.current_print_version(text) TO artepool_api;
