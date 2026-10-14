-- 0023_print_designer.sql
-- Purpose: the print designer (M4b, decisions 0064–0067):
--   * sys.company_bank_accounts: the company's bank accounts (bank, account name, UAE IBAN with
--     its checksum, optional SWIFT), owner only, never deleted (0065).
--   * Customer PO number on A4 invoices and quotations, fixed once issued (0066).
--   * A full tax invoice needs the customer's address (0064): the address is taken from the
--     customer at issue when the draft has none, and the issue is refused when there is still none.
--   * The current template of a kind can only point at one of its own versions, and only the owner
--     changes it (0020).
--   * The thermal receipt's language moves into its template (0064): a new receipt version with
--     the value of the old setting print.receipt_language, which is no longer read.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0023: print designer (decisions 0064-0067)');

-- ---------------------------------------------------------------------------------------------
-- UAE IBAN (0065): AE + 21 digits, ISO 13616 checksum (mod 97 of the rearranged number is 1)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION sys.valid_uae_iban(p_iban text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT p_iban ~ '^AE[0-9]{21}$'
     AND (substr(p_iban, 5) || '1014' || substr(p_iban, 3, 2))::numeric % 97 = 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Company bank accounts (0065)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sys.company_bank_accounts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_name     text NOT NULL CHECK (btrim(bank_name) <> '' AND length(bank_name) <= 100),
  account_name  text NOT NULL CHECK (btrim(account_name) <> '' AND length(account_name) <= 150),
  iban          text NOT NULL CHECK (sys.valid_uae_iban(iban)),
  swift         text CHECK (swift ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  sort_order    smallint NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 999),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint NOT NULL REFERENCES auth.users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint NOT NULL REFERENCES auth.users (id),
  row_version   integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX company_bank_accounts_iban_uq ON sys.company_bank_accounts (iban) WHERE is_active;
SELECT sys.add_touch('sys.company_bank_accounts');
SELECT sys.add_deactivation_reason('sys.company_bank_accounts');
SELECT audit.enable_for('sys.company_bank_accounts');
SELECT sys.forbid_delete('sys.company_bank_accounts');

-- Only the owner (system.company.edit is owner-only, 0030) writes them.
CREATE FUNCTION sys.bank_account_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF sys.require_user() <> 1 AND NOT auth.user_has_permission(sys.require_user(), 'system.company.edit') THEN
    RAISE EXCEPTION 'Only the owner edits the company''s bank accounts'
      USING ERRCODE = 'AP012', HINT = 'COMPANY_OWNER_ONLY';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_bank_account_rules BEFORE INSERT OR UPDATE ON sys.company_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION sys.bank_account_rules();

-- ---------------------------------------------------------------------------------------------
-- Customer PO number (0066)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE sales.documents
  ADD COLUMN customer_po text CHECK (customer_po IS NULL OR (btrim(customer_po) <> '' AND length(customer_po) <= 50));
ALTER TABLE sales.quotations
  ADD COLUMN customer_po text CHECK (customer_po IS NULL OR (btrim(customer_po) <> '' AND length(customer_po) <= 50));

-- ---------------------------------------------------------------------------------------------
-- A full tax invoice carries the customer's address (0064)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION sales.full_invoice_address() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c md.customers;
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'issued'
     AND NEW.doc_type IN ('invoice', 'advance_invoice', 'debit_note') THEN
    SELECT * INTO c FROM md.customers WHERE id = NEW.customer_id;
    IF c.is_vat_registered THEN
      IF NEW.bill_to_address IS NULL OR btrim(NEW.bill_to_address) = '' THEN
        NEW.bill_to_address := nullif(concat_ws('، ', nullif(btrim(c.address_line), ''),
                                                nullif(btrim(c.area), ''), nullif(btrim(c.city), '')), '');
      END IF;
      IF NEW.bill_to_address IS NULL THEN
        RAISE EXCEPTION 'A full tax invoice needs the customer''s address'
          USING ERRCODE = 'AP011', HINT = 'FULL_INVOICE_ADDRESS';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_full_invoice_address BEFORE UPDATE OF status ON sales.documents
  FOR EACH ROW EXECUTE FUNCTION sales.full_invoice_address();

-- ---------------------------------------------------------------------------------------------
-- The current template version: one of the template's own, set by the owner only (0020)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION sys.print_current_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    IF sys.require_user() <> 1 AND NOT auth.user_has_permission(sys.require_user(), 'print_templates.manage') THEN
      RAISE EXCEPTION 'Only the owner designs print templates' USING ERRCODE = 'AP012', HINT = 'PRINT_OWNER_ONLY';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM sys.print_template_versions
                    WHERE id = NEW.current_version_id AND template_id = NEW.id) THEN
      RAISE EXCEPTION 'A template uses one of its own versions' USING ERRCODE = 'AP011', HINT = 'PRINT_VERSION';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_print_current_rules BEFORE UPDATE OF current_version_id ON sys.print_templates
  FOR EACH ROW EXECUTE FUNCTION sys.print_current_rules();

-- ---------------------------------------------------------------------------------------------
-- The thermal receipt's language moves into its template (0064)
-- ---------------------------------------------------------------------------------------------
INSERT INTO sys.print_template_versions (template_id, settings, note)
SELECT t.id,
       v.settings || jsonb_build_object('language', coalesce((SELECT value #>> '{}' FROM sys.settings
                                                               WHERE key = 'print.receipt_language'), 'both')),
       'Receipt language moved into the template (decision 0064)'
  FROM sys.print_templates t
  JOIN sys.print_template_versions v ON v.id = t.current_version_id
 WHERE t.doc_kind = 'receipt_thermal';
UPDATE sys.print_templates t
   SET current_version_id = (SELECT max(id) FROM sys.print_template_versions v WHERE v.template_id = t.id)
 WHERE t.doc_kind = 'receipt_thermal';
UPDATE sys.settings
   SET description = 'No longer used: the receipt language is set in the print designer (decision 0064)'
 WHERE key = 'print.receipt_language';

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON sys.company_bank_accounts TO artepool_api;
GRANT INSERT (bank_name, account_name, iban, swift, sort_order, is_active)
  ON sys.company_bank_accounts TO artepool_api;
GRANT UPDATE (bank_name, account_name, iban, swift, sort_order, is_active)
  ON sys.company_bank_accounts TO artepool_api;
GRANT INSERT (customer_po), UPDATE (customer_po) ON sales.documents, sales.quotations TO artepool_api;
GRANT EXECUTE ON FUNCTION sys.valid_uae_iban(text) TO artepool_api;
