-- 0049_customer_balance.sql
-- Purpose: the customer's balance wherever a customer is chosen (decision 0114).
--  1. The permission customers.balance.view: the amounts (outstanding, overdue, credit limit,
--     available, advance payments). Without it, only the colour and the status words. Owner and
--     accountant; the owner can give it to others.
--  2. What an invoice prints in its optional balance block, frozen at issue so a reprint shows the
--     same numbers: the customer's balance just before it (from posted documents only), what was
--     paid at issue, and whether the customer was on credit then.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0049: the customer''s balance (decision 0114)');

INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('customers.balance.view', 'masterdata', 'عرض أرصدة العملاء (المبالغ)',
        'View customer balances (amounts)', true, false, false);
INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT id, 'customers.balance.view' FROM auth.roles WHERE code IN ('owner', 'accountant');

ALTER TABLE sales.documents
  ADD COLUMN balance_before_fils bigint,
  ADD COLUMN paid_at_issue_fils bigint CHECK (paid_at_issue_fils IS NULL OR paid_at_issue_fils >= 0),
  ADD COLUMN credit_customer boolean;
-- Set once, in the update that issues the invoice (the row is still a draft then).
GRANT UPDATE (balance_before_fils, paid_at_issue_fils, credit_customer) ON sales.documents TO artepool_api;
