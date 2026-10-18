-- 0033_owner_dashboard.sql
-- Purpose: the owner's dashboard (decisions 0039, 0081): sales, VAT, profit, cash, receivables
-- and stock at a glance. Cost and profit are the owner's alone, so the permission is owner-only.
-- No new table: the dashboard reads issued documents, payments, shifts, the ledger and stock.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0033: the owner dashboard (decision 0081)');

INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('reports.owner_dashboard', 'reports', 'لوحة المالك (المبيعات والربح)',
        'Owner dashboard (sales and profit)', true, false, true);
INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT id, 'reports.owner_dashboard' FROM auth.roles WHERE code = 'owner';

-- Issued documents by day: the dashboard's main read.
CREATE INDEX IF NOT EXISTS documents_issued_day_ix
  ON sales.documents (issue_date, doc_type) WHERE status = 'issued';
