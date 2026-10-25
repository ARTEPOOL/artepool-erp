-- 0028_approval_codes.sql
-- Purpose: supervisor approvals are given with the one-time code from the approver's 2-step app
-- (decision 0074). Wrong codes count separately from PIN and password failures, and after too
-- many the person's approvals are blocked until the owner unblocks them; their sign-in is not.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0028: approval codes (decision 0074)');

ALTER TABLE auth.users
  ADD COLUMN approval_failed_count smallint NOT NULL DEFAULT 0 CHECK (approval_failed_count >= 0),
  ADD COLUMN approval_blocked_at timestamptz;

GRANT UPDATE (approval_failed_count, approval_blocked_at) ON auth.users TO artepool_api;
