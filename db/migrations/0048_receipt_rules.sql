-- 0048_receipt_rules.sql
-- Purpose: receipts settle open invoices first (decision 0113).
--  1. The permission sales.advance_with_open_invoices: a receipt may be kept whole as an advance
--     (with its own payment tax invoice, 0013) while the customer still has open invoices only
--     with it, and only with a reason (a deposit for a new project while an old invoice is
--     disputed). Owner and accountant.
--  2. sales.payments.advance_reason: that reason, kept on the receipt (and in the audit log).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0048: receipts settle open invoices first (decision 0113)');

INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('sales.advance_with_open_invoices', 'sales', 'دفعة مقدمة والعميل عليه فواتير مفتوحة',
        'Advance payment while the customer has open invoices', true, false, false);
INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT id, 'sales.advance_with_open_invoices' FROM auth.roles WHERE code IN ('owner', 'accountant');

ALTER TABLE sales.payments
  ADD COLUMN advance_reason text CHECK (advance_reason IS NULL OR length(btrim(advance_reason)) BETWEEN 3 AND 500);
GRANT INSERT (advance_reason) ON sales.payments TO artepool_api;
