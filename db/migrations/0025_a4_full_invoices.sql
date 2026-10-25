-- 0025_a4_full_invoices.sql
-- Purpose: every A4 invoice (office channel) is a full tax invoice, whatever the customer's VAT
-- registration (decision 0071, refines 0010). A full tax invoice needs the customer's name and
-- address: for the walk-in cash customer they are typed on the invoice, and the issue is refused
-- while the name is still the walk-in's own ("Cash customer") or the address is missing.
-- POS sales, advance (payment) invoices and debit notes keep following the customer (0010).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0025: A4 invoices are full tax invoices (decision 0071)');

-- A TRN always means a full invoice; a full invoice without a TRN only for an A4 invoice.
ALTER TABLE sales.documents DROP CONSTRAINT documents_format_ck;
ALTER TABLE sales.documents ADD CONSTRAINT documents_format_ck CHECK (
  status <> 'issued'
  OR ((bill_to_trn IS NULL OR invoice_format = 'full')
      AND (invoice_format = 'simplified' OR bill_to_trn IS NOT NULL
           OR (channel = 'office' AND doc_type = 'invoice'))));

-- Runs after sales.document_rules (b_document_rules), which sets the format from the customer.
CREATE OR REPLACE FUNCTION sales.full_invoice_address() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c md.customers;
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'issued'
     AND NEW.doc_type IN ('invoice', 'advance_invoice', 'debit_note') THEN
    SELECT * INTO c FROM md.customers WHERE id = NEW.customer_id;
    IF c.is_vat_registered OR (NEW.channel = 'office' AND NEW.doc_type = 'invoice') THEN
      NEW.invoice_format := 'full';
      IF c.is_walk_in AND btrim(NEW.bill_to_name) = btrim(c.name) THEN
        RAISE EXCEPTION 'A full tax invoice needs the customer''s name'
          USING ERRCODE = 'AP011', HINT = 'FULL_INVOICE_NAME';
      END IF;
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
