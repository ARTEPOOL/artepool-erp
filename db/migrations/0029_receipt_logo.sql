-- 0029_receipt_logo.sql
-- Purpose: the thermal receipt can have a logo of its own, separate from the company logo that
-- every A4 document prints (decision 0075). Empty = the receipt uses the company logo. One row,
-- changed by the owner only (print_templates.manage), never deleted; the image bytes are left out
-- of the audit log (like the company logo), the change itself is audited.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0029: receipt logo (decision 0075)');

CREATE TABLE sys.receipt_logo (
  id           smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  logo         bytea CHECK (logo IS NULL OR octet_length(logo) BETWEEN 1 AND 524288),
  logo_mime    text CHECK (logo_mime IN ('image/png', 'image/jpeg')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint NOT NULL REFERENCES auth.users (id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   bigint NOT NULL REFERENCES auth.users (id),
  row_version  integer NOT NULL DEFAULT 1,
  CONSTRAINT receipt_logo_ck CHECK ((logo IS NULL) = (logo_mime IS NULL))
);
SELECT sys.add_touch('sys.receipt_logo');
SELECT audit.enable_for('sys.receipt_logo', p_redacted => ARRAY['logo']);
SELECT sys.forbid_delete('sys.receipt_logo');

CREATE FUNCTION sys.receipt_logo_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF sys.require_user() <> 1 AND NOT auth.user_has_permission(sys.require_user(), 'print_templates.manage') THEN
    RAISE EXCEPTION 'Only the owner changes the receipt logo' USING ERRCODE = 'AP012', HINT = 'PRINT_OWNER_ONLY';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_receipt_logo_rules BEFORE INSERT OR UPDATE ON sys.receipt_logo
  FOR EACH ROW EXECUTE FUNCTION sys.receipt_logo_rules();

INSERT INTO sys.receipt_logo (id, created_by, updated_by) VALUES (1, 1, 1);

GRANT SELECT ON sys.receipt_logo TO artepool_api;
GRANT UPDATE (logo, logo_mime) ON sys.receipt_logo TO artepool_api;
