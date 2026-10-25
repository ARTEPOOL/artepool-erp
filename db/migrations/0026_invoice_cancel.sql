-- 0026_invoice_cancel.sql
-- Purpose: cancelling or editing an issued A4 invoice with the owner's approval (decision 0072).
-- An issued tax invoice never changes and is never deleted: it is cancelled by a credit note for
-- the whole invoice (stock back, VAT reversed, paid money refunded at once). "Edit" does the same,
-- then opens a new draft copied from it. The permission is the owner's; anyone else needs the
-- owner's approval.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0026: cancel or edit an issued invoice (decision 0072)');

INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('invoices.cancel', 'sales', 'إلغاء أو تعديل فاتورة صادرة', 'Cancel or edit an issued invoice',
        true, true, true);
INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT id, 'invoices.cancel' FROM auth.roles WHERE code = 'owner';

INSERT INTO sys.reason_codes (category, code, name_ar, name_en, requires_note) VALUES
  ('credit_note', 'INVOICE_CANCELLED', 'إلغاء الفاتورة', 'Invoice cancelled', true),
  ('credit_note', 'INVOICE_EDITED', 'تعديل الفاتورة (فاتورة بديلة)', 'Invoice edited (replaced)', true);
