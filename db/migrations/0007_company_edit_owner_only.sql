-- 0007_company_edit_owner_only.sql
-- Purpose: company details (name, TRN, address, logo — printed on every tax invoice) can be edited
-- by the owner only (decision 0030). The accountant keeps viewing, verifying and exporting the
-- audit log. Removes "system.company.edit" from every other role, then marks it owner-only so it
-- can never be given to another role again.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0007: company details are owner-only (decision 0030)');

DELETE FROM auth.role_permissions AS rp
 USING auth.roles AS r
 WHERE rp.role_id = r.id
   AND r.code <> 'owner'
   AND rp.permission_code = 'system.company.edit';

UPDATE auth.permissions SET owner_only = true WHERE code = 'system.company.edit';
