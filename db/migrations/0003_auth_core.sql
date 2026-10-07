-- 0003_auth_core.sql
-- Purpose: users, roles, permissions and the default role matrix (docs/database-schema.md §5.1–5.5,
-- §15.1). Login logic (passwords, PINs, TOTP, sessions) arrives with milestone M1.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0003: users, roles and permissions');

-- ---------------------------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.users (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username              text NOT NULL CHECK (username ~ '^[a-z0-9._-]{3,32}$'),
  display_name_ar       text NOT NULL CHECK (btrim(display_name_ar) <> ''),
  display_name_en       text NOT NULL CHECK (btrim(display_name_en) <> ''),
  phone                 text,
  email                 text,
  password_hash         text,
  password_changed_at   timestamptz,
  must_change_password  boolean NOT NULL DEFAULT true,
  pin_hash              text,
  pin_failed_count      smallint NOT NULL DEFAULT 0 CHECK (pin_failed_count >= 0),
  totp_secret_enc       bytea,
  totp_enabled          boolean NOT NULL DEFAULT false,
  totp_last_step        bigint,
  failed_login_count    smallint NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until          timestamptz,
  last_login_at         timestamptz,
  language              text NOT NULL DEFAULT 'ar' CHECK (language IN ('ar', 'en')),
  max_discount_bp       integer CHECK (max_discount_bp BETWEEN 0 AND 10000),
  max_discount_fils     bigint CHECK (max_discount_fils >= 0),
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            bigint NOT NULL REFERENCES auth.users (id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            bigint NOT NULL REFERENCES auth.users (id),
  row_version           integer NOT NULL DEFAULT 1,
  CONSTRAINT users_password_ck CHECK (id = 1 OR password_hash IS NOT NULL),
  CONSTRAINT users_system_ck CHECK (
    id <> 1 OR (password_hash IS NULL AND pin_hash IS NULL AND NOT totp_enabled)),
  CONSTRAINT users_totp_ck CHECK (NOT totp_enabled OR totp_secret_enc IS NOT NULL)
);
CREATE UNIQUE INDEX users_username_uq ON auth.users (lower(username));
COMMENT ON TABLE auth.users IS 'People who log in. User 1 is the built-in SYSTEM user (cannot log in).';

SELECT sys.add_touch('auth.users');
SELECT audit.enable_for('auth.users',
  p_ignored => ARRAY['last_login_at', 'failed_login_count', 'pin_failed_count', 'totp_last_step'],
  p_redacted => ARRAY['password_hash', 'pin_hash', 'totp_secret_enc']);
SELECT sys.forbid_delete('auth.users');

CREATE FUNCTION auth.guard_system_user() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The built-in SYSTEM user cannot be changed' USING ERRCODE = 'AP003';
END $$;
CREATE TRIGGER guard_system_user BEFORE UPDATE ON auth.users
  FOR EACH ROW WHEN (OLD.id = 1) EXECUTE FUNCTION auth.guard_system_user();

INSERT INTO auth.users (id, username, display_name_ar, display_name_en, must_change_password,
                        created_by, updated_by)
OVERRIDING SYSTEM VALUE
VALUES (1, 'system', 'النظام', 'System', false, 1, 1);
SELECT setval(pg_get_serial_sequence('auth.users', 'id'), 1);

-- ---------------------------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.roles (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code               text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name_ar            text NOT NULL CHECK (btrim(name_ar) <> ''),
  name_en            text NOT NULL CHECK (btrim(name_en) <> ''),
  is_system          boolean NOT NULL DEFAULT false,
  requires_2fa       boolean NOT NULL DEFAULT false,
  max_discount_bp    integer NOT NULL DEFAULT 0 CHECK (max_discount_bp BETWEEN 0 AND 10000),
  max_discount_fils  bigint NOT NULL DEFAULT 0 CHECK (max_discount_fils >= 0),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         bigint NOT NULL REFERENCES auth.users (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         bigint NOT NULL REFERENCES auth.users (id),
  row_version        integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX roles_code_uq ON auth.roles (lower(code));

SELECT sys.add_touch('auth.roles');
SELECT audit.enable_for('auth.roles');
SELECT sys.forbid_delete('auth.roles');

CREATE FUNCTION auth.guard_system_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code OR NOT NEW.is_active OR NOT NEW.is_system THEN
    RAISE EXCEPTION 'Default role "%" cannot be renamed or deactivated', OLD.code USING ERRCODE = 'AP003';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_system_role BEFORE UPDATE ON auth.roles
  FOR EACH ROW WHEN (OLD.is_system) EXECUTE FUNCTION auth.guard_system_role();

INSERT INTO auth.roles (code, name_ar, name_en, is_system, requires_2fa, max_discount_bp, max_discount_fils)
VALUES
  ('owner',       'المالك',       'Owner',       true, true, 10000, 9223372036854775807),
  ('accountant',  'المحاسب',      'Accountant',  true, false, 0, 0),
  ('cashier',     'أمين الصندوق', 'Cashier',     true, false, 0, 0),
  ('storekeeper', 'أمين المخزن',  'Storekeeper', true, false, 0, 0),
  ('technician',  'الفني',        'Technician',  true, false, 0, 0);

-- ---------------------------------------------------------------------------------------------
-- Permissions (granular, per action). * = approvable: a supervisor approval can stand in, once.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.permissions (
  code          text PRIMARY KEY CHECK (code ~ '^[a-z_]+(\.[a-z_]+)+$'),
  module        text NOT NULL,
  name_ar       text NOT NULL,
  name_en       text NOT NULL,
  is_sensitive  boolean NOT NULL DEFAULT false,
  approvable    boolean NOT NULL DEFAULT false
);
SELECT audit.enable_for('auth.permissions', p_keys => ARRAY['code']);
SELECT sys.forbid_delete('auth.permissions');

INSERT INTO auth.permissions (code, module, name_ar, name_en, is_sensitive, approvable) VALUES
  ('system.company.edit',          'system',     'تعديل بيانات الشركة',              'Edit company profile',            true,  false),
  ('system.settings.edit',         'system',     'تعديل الإعدادات',                  'Edit settings',                   true,  false),
  ('system.series.manage',         'system',     'إدارة تسلسلات الترقيم',            'Manage numbering series',         true,  false),
  ('system.devices.manage',        'system',     'إدارة الأجهزة',                    'Manage devices',                  true,  false),
  ('system.health.view',           'system',     'عرض حالة النظام',                  'View system health',              false, false),
  ('system.backup.restore_test',   'system',     'تشغيل اختبار الاستعادة',           'Run restore test',                true,  false),
  ('system.integrity.run',         'system',     'تشغيل فحوصات السلامة',             'Run integrity checks',            false, false),
  ('users.view',                   'users',      'عرض المستخدمين',                   'View users',                      false, false),
  ('users.manage',                 'users',      'إدارة المستخدمين',                 'Manage users',                    true,  false),
  ('users.reset_credentials',      'users',      'إعادة تعيين بيانات الدخول',        'Reset login credentials',         true,  false),
  ('roles.manage',                 'users',      'إدارة الأدوار والصلاحيات',         'Manage roles and permissions',    true,  false),
  ('audit.view',                   'audit',      'عرض سجل التدقيق',                  'View audit log',                  true,  false),
  ('audit.verify',                 'audit',      'التحقق من سلسلة التدقيق',          'Verify audit chain',              true,  false),
  ('audit.export',                 'audit',      'تصدير سجل التدقيق',                'Export audit log',                true,  false),
  ('items.view',                   'masterdata', 'عرض الأصناف',                      'View items',                      false, false),
  ('items.manage',                 'masterdata', 'إدارة الأصناف',                    'Manage items',                    false, false),
  ('prices.manage',                'masterdata', 'إدارة الأسعار',                    'Manage prices',                   true,  false),
  ('customers.view',               'masterdata', 'عرض العملاء',                      'View customers',                  false, false),
  ('customers.manage',             'masterdata', 'إدارة العملاء',                    'Manage customers',                false, false),
  ('suppliers.manage',             'masterdata', 'إدارة الموردين',                   'Manage suppliers',                false, false),
  ('technicians.manage',           'masterdata', 'إدارة الفنيين',                    'Manage technicians',              false, false),
  ('payment_methods.manage',       'masterdata', 'إدارة طرق الدفع',                  'Manage payment methods',          true,  false),
  ('warehouses.manage',            'masterdata', 'إدارة المستودعات',                 'Manage warehouses',               false, false),
  ('data.import',                  'masterdata', 'استيراد البيانات',                 'Import data',                     true,  false),
  ('stock.view',                   'inventory',  'عرض المخزون',                      'View stock',                      false, false),
  ('stock.view_cost',              'inventory',  'عرض تكلفة المخزون',                'View stock cost',                 true,  false),
  ('stock.adjust',                 'inventory',  'تسوية المخزون',                    'Adjust stock',                    false, false),
  ('stock.adjust_over_threshold',  'inventory',  'تسوية مخزون تتجاوز الحد',          'Adjust stock above threshold',    true,  true),
  ('stock.count',                  'inventory',  'جرد المخزون',                      'Count stock',                     false, false),
  ('stock.count_post',             'inventory',  'ترحيل الجرد',                      'Post stock count',                false, false),
  ('stock.defective',              'inventory',  'نقل البضاعة إلى التالف',           'Move goods to defective',         false, false),
  ('stock.write_off',              'inventory',  'شطب المخزون التالف',               'Write off defective stock',       true,  false),
  ('stock.oversell_review',        'inventory',  'مراجعة البيع بدون رصيد',           'Review oversells',                false, false),
  ('labels.print',                 'inventory',  'طباعة ملصقات الباركود',            'Print barcode labels',            false, false),
  ('invoices.view',                'sales',      'عرض الفواتير',                     'View invoices',                   false, false),
  ('quotations.manage',            'sales',      'إدارة عروض الأسعار',               'Manage quotations',               false, false),
  ('invoices.create',              'sales',      'إنشاء الفواتير',                   'Create invoices',                 false, false),
  ('invoices.issue',               'sales',      'إصدار الفواتير',                   'Issue invoices',                  false, false),
  ('sales.discount_over_limit',    'sales',      'خصم يتجاوز الحد المسموح',          'Discount above limit',            true,  true),
  ('sales.price_override',         'sales',      'تعديل سعر البيع',                  'Override selling price',          true,  true),
  ('sales.credit_over_limit',      'sales',      'بيع آجل يتجاوز حد الائتمان',       'Credit sale above credit limit',  true,  true),
  ('credit_notes.issue',           'sales',      'إصدار إشعار دائن',                 'Issue credit notes',              true,  true),
  ('debit_notes.issue',            'sales',      'إصدار إشعار مدين',                 'Issue debit notes',               false, false),
  ('payments.receive',             'sales',      'استلام الدفعات',                   'Receive payments',                false, false),
  ('payments.refund',              'sales',      'رد المبالغ',                       'Refund payments',                 true,  true),
  ('payments.reverse',             'sales',      'عكس الدفعات',                      'Reverse payments',                true,  true),
  ('statements.view',              'sales',      'عرض كشوف الحساب',                  'View statements of account',      false, false),
  ('documents.reprint',            'sales',      'إعادة طباعة المستندات',            'Reprint documents',               false, false),
  ('pos.sell',                     'pos',        'البيع في نقطة البيع',              'Sell at the POS',                 false, false),
  ('pos.oversell',                 'pos',        'البيع بدون رصيد كافٍ',             'Sell beyond available stock',     true,  true),
  ('pos.no_sale',                  'pos',        'فتح الدرج بدون بيع',               'Open drawer without a sale',      true,  false),
  ('shifts.open',                  'cash',       'فتح الوردية',                      'Open a shift',                    false, false),
  ('shifts.close',                 'cash',       'إغلاق الوردية',                    'Close a shift',                   false, false),
  ('shifts.recount',               'cash',       'إعادة عدّ النقدية',                'Recount cash at shift close',     true,  true),
  ('shifts.view_all',              'cash',       'عرض جميع الورديات',                'View all shifts',                 false, false),
  ('cash.paid_in',                 'cash',       'إيداع نقدي في الدرج',              'Paid-in to drawer',               false, false),
  ('cash.paid_out',                'cash',       'صرف نقدي من الدرج',                'Paid-out from drawer',            true,  true),
  ('cash.drop',                    'cash',       'تحويل النقدية إلى الخزنة',         'Cash drop to safe',               false, false),
  ('cash.variance_accept',         'cash',       'اعتماد فرق النقدية',               'Accept cash variance',            true,  true),
  ('reports.x',                    'cash',       'تقرير X',                          'X report',                        false, false),
  ('ledger.view',                  'ledger',     'عرض القيود',                       'View journal entries',            false, false),
  ('accounts.manage',              'ledger',     'إدارة دليل الحسابات',              'Manage chart of accounts',        true,  false),
  ('periods.manage',               'ledger',     'إدارة الفترات المحاسبية',          'Manage accounting periods',       true,  false),
  ('data.export',                  'export',     'تصدير البيانات',                   'Export data',                     true,  false);

-- ---------------------------------------------------------------------------------------------
-- Role ↔ permission, user ↔ role (link tables: deleting a link is allowed and audited)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.role_permissions (
  role_id          bigint NOT NULL REFERENCES auth.roles (id),
  permission_code  text NOT NULL REFERENCES auth.permissions (code),
  granted_at       timestamptz NOT NULL DEFAULT now(),
  granted_by       bigint NOT NULL REFERENCES auth.users (id),
  PRIMARY KEY (role_id, permission_code)
);
SELECT sys.add_stamp('auth.role_permissions', 'granted_at', 'granted_by');
SELECT audit.enable_for('auth.role_permissions', p_keys => ARRAY['role_id', 'permission_code']);
SELECT sys.forbid_delete('auth.role_permissions', p_allow_delete => true);

CREATE TABLE auth.user_roles (
  user_id     bigint NOT NULL REFERENCES auth.users (id),
  role_id     bigint NOT NULL REFERENCES auth.roles (id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  bigint NOT NULL REFERENCES auth.users (id),
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX user_roles_role_ix ON auth.user_roles (role_id);
SELECT sys.add_stamp('auth.user_roles', 'granted_at', 'granted_by');
SELECT audit.enable_for('auth.user_roles', p_keys => ARRAY['user_id', 'role_id']);
SELECT sys.forbid_delete('auth.user_roles', p_allow_delete => true);

-- Default role matrix (docs/database-schema.md §15.1). Editable later by the owner.
INSERT INTO auth.role_permissions (role_id, permission_code)
SELECT r.id, p.code
  FROM auth.roles AS r
  JOIN auth.permissions AS p ON (
       r.code = 'owner'
    OR (r.code = 'accountant' AND p.code NOT IN (
          'users.view', 'users.manage', 'users.reset_credentials', 'roles.manage',
          'system.devices.manage', 'system.settings.edit', 'system.series.manage'))
    OR (r.code = 'cashier' AND p.code IN (
          'pos.sell', 'payments.receive', 'shifts.open', 'shifts.close', 'cash.drop',
          'cash.paid_in', 'reports.x', 'items.view', 'customers.view', 'customers.manage',
          'labels.print', 'invoices.view', 'documents.reprint'))
    OR (r.code = 'storekeeper' AND (
          (p.code LIKE 'stock.%' AND p.code <> 'stock.view_cost')
          OR p.code IN ('items.view', 'labels.print')))
    OR (r.code = 'technician' AND p.code IN ('items.view', 'customers.view')));

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON auth.users TO artepool_api;
GRANT UPDATE (username, display_name_ar, display_name_en, phone, email, password_hash,
              password_changed_at, must_change_password, pin_hash, pin_failed_count,
              totp_secret_enc, totp_enabled, totp_last_step, failed_login_count, locked_until,
              last_login_at, language, max_discount_bp, max_discount_fils, is_active)
  ON auth.users TO artepool_api;
GRANT SELECT, INSERT ON auth.roles TO artepool_api;
GRANT UPDATE (code, name_ar, name_en, requires_2fa, max_discount_bp, max_discount_fils, is_active)
  ON auth.roles TO artepool_api;
GRANT SELECT ON auth.permissions TO artepool_api;
GRANT SELECT, INSERT, DELETE ON auth.role_permissions, auth.user_roles TO artepool_api;
