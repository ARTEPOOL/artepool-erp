-- 0045_server_health.sql
-- Purpose: the server PC's health on the System health screen (M6.2 part H).
--  1. ops.server_health: one row with what the owner confirms (a UPS is connected) and what the
--     server PC's updater records about the server certificate: its expiry date, the last
--     automatic renewal and the last failed try. Every change is audited (old and new expiry
--     dates of each renewal; never a key or any other secret).
--  2. system.health.manage: the owner's (confirming the UPS).
--  3. New alerts for the owner: UPS not confirmed, disk space, a service down, WAL archiving
--     failing, the server certificate or the root CA close to expiry, a failed renewal.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0045: server health (M6.2 part H)');

CREATE TABLE ops.server_health (
  id                       smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- The owner confirmed a UPS is connected to the server PC (asked again after six months).
  ups_confirmed_at         timestamptz,
  -- The server certificate in use, as the updater last saw it.
  cert_expires_at          timestamptz,
  -- The last automatic renewal that was checked and switched to.
  cert_renewed_at          timestamptz,
  -- The last try (successful or not); a failure is tried again the next day.
  cert_renew_attempted_at  timestamptz,
  cert_renew_error         text CHECK (length(cert_renew_error) <= 500),
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               bigint NOT NULL REFERENCES auth.users (id),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               bigint NOT NULL REFERENCES auth.users (id),
  row_version              integer NOT NULL DEFAULT 1
);
COMMENT ON TABLE ops.server_health IS
  'The server PC''s health (M6.2 part H): UPS confirmed by the owner; the server certificate''s expiry and its automatic renewals. One row.';

-- Only the owner confirms the UPS (the API checks system.health.manage too).
CREATE FUNCTION ops.server_health_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ups_confirmed_at IS DISTINCT FROM OLD.ups_confirmed_at
     AND NOT auth.is_owner(sys.require_user()) THEN
    RAISE EXCEPTION 'Only the owner confirms the UPS' USING ERRCODE = 'AP010';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_server_health_guard BEFORE UPDATE ON ops.server_health
  FOR EACH ROW EXECUTE FUNCTION ops.server_health_guard();
SELECT sys.add_touch('ops.server_health');
SELECT audit.enable_for('ops.server_health');
SELECT sys.forbid_delete('ops.server_health');
INSERT INTO ops.server_health DEFAULT VALUES;

INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable, owner_only)
VALUES ('system.health.manage', 'system', 'تأكيدات صحة النظام (الـ UPS)',
        'System health confirmations (the UPS)', true, false, true);
INSERT INTO auth.role_permissions (role_id, permission_code)
VALUES (auth.owner_role_id(), 'system.health.manage');

ALTER TABLE sys.alerts DROP CONSTRAINT alerts_alert_type_check;
ALTER TABLE sys.alerts ADD CONSTRAINT alerts_alert_type_check CHECK (alert_type IN (
  'low_stock', 'oversell_review', 'cash_drop_due', 'cash_variance',
  'repeated_variance', 'drawer_left_open', 'backup_failed', 'backup_stale',
  'restore_test_due', 'integrity_issue', 'audit_chain_broken', 'clock_skew',
  'clock_backwards', 'period_missing',
  'kiosk_lock_off', 'kiosk_lock_on', 'kiosk_exit_attempt', 'kiosk_code_blocked',
  'offline_copy_due',
  'ups_unconfirmed', 'disk_low', 'disk_urgent', 'service_down', 'wal_archive_failed',
  'certificate_expiring', 'certificate_renewal_failed', 'root_ca_expiring'));

-- The API shows it and saves the owner's UPS confirmation; the updater (as the backup role, from
-- the launcher on the server PC) records the certificate and its renewals.
GRANT SELECT ON ops.server_health TO artepool_api, artepool_backup;
GRANT UPDATE (ups_confirmed_at) ON ops.server_health TO artepool_api;
GRANT UPDATE (cert_expires_at, cert_renewed_at, cert_renew_attempted_at, cert_renew_error)
  ON ops.server_health TO artepool_backup;
