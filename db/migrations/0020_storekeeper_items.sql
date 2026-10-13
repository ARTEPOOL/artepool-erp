-- The owner's decision (0053, 2026-10-13): the storekeeper adds and edits items, so that a new
-- item's quantity on hand can be entered when it is created. Prices (prices.manage) and the
-- purchase price (items.cost, owner only) stay with their own permissions.

SELECT sys.set_context(1, p_reason => 'migration 0020: the storekeeper manages items (decision 0053)');

INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT id, 'items.manage' FROM auth.roles WHERE code = 'storekeeper'
ON CONFLICT DO NOTHING;
