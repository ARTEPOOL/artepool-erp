-- 0027_a4_format_from_customer.sql
-- Purpose: an A4 invoice takes the customer's name and address from the customer only, with
-- nothing typed on the invoice (decision 0071, revised): it is a full tax invoice when the
-- customer is VAT-registered, or is a named customer with an address on file; otherwise (the
-- walk-in cash customer, or a customer without an address) a simplified tax invoice, which the
-- law allows for an unregistered customer. A VAT-registered customer still needs an address.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0027: A4 invoice format from the customer (decision 0071)');

CREATE OR REPLACE FUNCTION sales.full_invoice_address() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c md.customers;
  v_address text;
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'issued'
     AND NEW.doc_type IN ('invoice', 'advance_invoice', 'debit_note') THEN
    SELECT * INTO c FROM md.customers WHERE id = NEW.customer_id;
    v_address := coalesce(nullif(btrim(NEW.bill_to_address), ''),
                          nullif(concat_ws('، ', nullif(btrim(c.address_line), ''),
                                           nullif(btrim(c.area), ''), nullif(btrim(c.city), '')), ''));
    IF c.is_vat_registered THEN
      IF v_address IS NULL THEN
        RAISE EXCEPTION 'A full tax invoice needs the customer''s address'
          USING ERRCODE = 'AP011', HINT = 'FULL_INVOICE_ADDRESS';
      END IF;
      NEW.bill_to_address := v_address;
    ELSIF NEW.channel = 'office' AND NEW.doc_type = 'invoice' AND NOT c.is_walk_in
          AND v_address IS NOT NULL THEN
      NEW.invoice_format := 'full';
      NEW.bill_to_address := v_address;
    END IF;
  END IF;
  RETURN NEW;
END $$;
