-- 0008_gl_core.sql
-- Purpose: the provisional chart of accounts (decision 0018, pending accountant review; 0035), the
-- account used for each event (mappings), and monthly accounting periods with close and lock
-- (decisions 0016, 0035). docs/database-schema.md §11.1–11.3. Journal entries come in 0011 (M3).
-- Rule errors use SQLSTATE AP011 with a machine-readable HINT that the app translates.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0008: chart of accounts, event links, periods');

-- ---------------------------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------------------------
CREATE TABLE gl.accounts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          text NOT NULL CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  name_ar       text NOT NULL CHECK (btrim(name_ar) <> ''),
  name_en       text NOT NULL CHECK (btrim(name_en) <> ''),
  account_type  text NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  parent_id     bigint REFERENCES gl.accounts (id),
  is_postable   boolean NOT NULL DEFAULT true,
  is_control    boolean NOT NULL DEFAULT false,
  is_contra     boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint NOT NULL REFERENCES auth.users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint NOT NULL REFERENCES auth.users (id),
  row_version   integer NOT NULL DEFAULT 1,
  CONSTRAINT accounts_parent_ck CHECK (parent_id <> id),
  -- Postings on a control account carry the customer (or supplier): only postable accounts.
  CONSTRAINT accounts_control_ck CHECK (is_postable OR NOT is_control)
);
CREATE UNIQUE INDEX accounts_code_uq ON gl.accounts (lower(code));
CREATE INDEX accounts_parent_ix ON gl.accounts (parent_id);

CREATE FUNCTION gl.account_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_parent gl.accounts;
  v_use text;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM gl.accounts WHERE id = NEW.parent_id;
    IF v_parent.is_postable THEN
      RAISE EXCEPTION 'The parent of account % must be a header account', NEW.code
        USING ERRCODE = 'AP011', HINT = 'ACCOUNT_PARENT_NOT_HEADER';
    END IF;
    IF v_parent.account_type <> NEW.account_type THEN
      RAISE EXCEPTION 'Account % must have the same type as its parent', NEW.code
        USING ERRCODE = 'AP011', HINT = 'ACCOUNT_PARENT_TYPE';
    END IF;
    IF NEW.is_active AND NOT v_parent.is_active THEN
      RAISE EXCEPTION 'Account % cannot be active under an inactive header', NEW.code
        USING ERRCODE = 'AP011', HINT = 'ACCOUNT_PARENT_INACTIVE';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id AND EXISTS (
         WITH RECURSIVE up AS (
           SELECT a.id, a.parent_id FROM gl.accounts AS a WHERE a.id = NEW.parent_id
           UNION ALL
           SELECT a.id, a.parent_id FROM gl.accounts AS a JOIN up ON a.id = up.parent_id)
         SELECT 1 FROM up WHERE up.id = NEW.id) THEN
      RAISE EXCEPTION 'Account % cannot sit under one of its own sub-accounts', NEW.code
        USING ERRCODE = 'AP011', HINT = 'ACCOUNT_LOOP';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (SELECT 1 FROM gl.accounts WHERE parent_id = NEW.id) THEN
      IF NEW.is_postable THEN
        RAISE EXCEPTION 'Account % has sub-accounts, so it must stay a header', NEW.code
          USING ERRCODE = 'AP011', HINT = 'ACCOUNT_HAS_CHILDREN';
      END IF;
      IF NEW.account_type <> OLD.account_type THEN
        RAISE EXCEPTION 'Account % has sub-accounts, so its type cannot change', NEW.code
          USING ERRCODE = 'AP011', HINT = 'ACCOUNT_HAS_CHILDREN';
      END IF;
      IF OLD.is_active AND NOT NEW.is_active
         AND EXISTS (SELECT 1 FROM gl.accounts WHERE parent_id = NEW.id AND is_active) THEN
        RAISE EXCEPTION 'Deactivate the sub-accounts of % first', NEW.code
          USING ERRCODE = 'AP011', HINT = 'ACCOUNT_HAS_CHILDREN';
      END IF;
    END IF;
    IF (NEW.account_type, NEW.is_postable, NEW.is_control, NEW.is_active)
       IS DISTINCT FROM (OLD.account_type, OLD.is_postable, OLD.is_control, OLD.is_active) THEN
      v_use := gl.account_in_use(NEW.id);
      IF v_use IS NOT NULL THEN
        RAISE EXCEPTION 'Account % is in use (%): its type, header choice, control flag and active state cannot change',
          NEW.code, v_use USING ERRCODE = 'AP011', HINT = 'ACCOUNT_IN_USE', DETAIL = v_use;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_account_rules BEFORE INSERT OR UPDATE ON gl.accounts
  FOR EACH ROW EXECUTE FUNCTION gl.account_rules();

SELECT sys.add_touch('gl.accounts');
SELECT audit.enable_for('gl.accounts');
SELECT sys.forbid_delete('gl.accounts');

-- Seed: the provisional chart from docs/accounting/chart-of-accounts.md (parents come first).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
  ('1000', 'الأصول', 'Assets', 'asset', NULL, false, false, false),
  ('1100', 'النقد والبنوك', 'Cash and bank', 'asset', '1000', false, false, false),
  ('1110', 'النقد في أدراج نقاط البيع', 'Cash on hand – POS drawers', 'asset', '1100', true, false, false),
  ('1120', 'النقد في الخزنة', 'Cash in safe', 'asset', '1100', true, false, false),
  ('1130', 'العهدة النقدية', 'Petty cash', 'asset', '1100', true, false, false),
  ('1140', 'البنك – الحساب الجاري', 'Bank – current account', 'asset', '1100', true, false, false),
  ('1150', 'مستحقات تسويات البطاقات', 'Card settlements receivable', 'asset', '1100', true, false, false),
  ('1160', 'شيكات تحت التحصيل', 'Cheques in hand', 'asset', '1100', true, false, false),
  ('1200', 'الذمم المدينة', 'Receivables', 'asset', '1000', false, false, false),
  ('1210', 'ذمم العملاء', 'Accounts receivable – customers', 'asset', '1200', true, true, false),
  ('1220', 'سلف الموظفين', 'Employee advances', 'asset', '1200', true, false, false),
  ('1230', 'ذمم مدينة أخرى', 'Other receivables', 'asset', '1200', true, false, false),
  ('1300', 'المخزون', 'Inventory', 'asset', '1000', false, false, false),
  ('1310', 'المخزون – صالح للبيع', 'Inventory – sellable', 'asset', '1300', true, false, false),
  ('1320', 'المخزون – تالف', 'Inventory – defective', 'asset', '1300', true, false, false),
  ('1400', 'أصول متداولة أخرى', 'Other current assets', 'asset', '1000', false, false, false),
  ('1410', 'ضريبة القيمة المضافة المستردة', 'VAT recoverable (input VAT)', 'asset', '1400', true, false, false),
  ('1420', 'مصروفات مدفوعة مقدماً', 'Prepaid expenses', 'asset', '1400', true, false, false),
  ('1430', 'دفعات مقدمة للموردين', 'Supplier advances', 'asset', '1400', true, false, false),
  ('1440', 'تأمينات مدفوعة', 'Deposits paid', 'asset', '1400', true, false, false),
  ('1500', 'الأصول الثابتة', 'Fixed assets', 'asset', '1000', false, false, false),
  ('1510', 'المركبات', 'Vehicles', 'asset', '1500', true, false, false),
  ('1520', 'العدد والمعدات', 'Tools and equipment', 'asset', '1500', true, false, false),
  ('1530', 'الأثاث والمعدات المكتبية', 'Furniture and office equipment', 'asset', '1500', true, false, false),
  ('1540', 'أجهزة الحاسوب وتقنية المعلومات', 'Computers and IT equipment', 'asset', '1500', true, false, false),
  ('1590', 'مجمع الإهلاك', 'Accumulated depreciation', 'asset', '1500', true, false, true),
  ('2000', 'الالتزامات', 'Liabilities', 'liability', NULL, false, false, false),
  ('2100', 'الالتزامات المتداولة', 'Current liabilities', 'liability', '2000', false, false, false),
  ('2110', 'ذمم الموردين', 'Accounts payable – suppliers', 'liability', '2100', true, true, false),
  ('2120', 'دفعات مقدمة من العملاء', 'Customer advances', 'liability', '2100', true, false, false),
  ('2130', 'ضريبة القيمة المضافة المستحقة', 'VAT payable (output VAT)', 'liability', '2100', true, false, false),
  ('2140', 'مصروفات مستحقة', 'Accrued expenses', 'liability', '2100', true, false, false),
  ('2150', 'رواتب مستحقة', 'Salaries payable', 'liability', '2100', true, false, false),
  ('2200', 'الالتزامات غير المتداولة', 'Non-current liabilities', 'liability', '2000', false, false, false),
  ('2210', 'مخصص مكافأة نهاية الخدمة', 'End-of-service benefits provision', 'liability', '2200', true, false, false),
  ('2220', 'القروض', 'Loans', 'liability', '2200', true, false, false),
  ('3000', 'حقوق الملكية', 'Equity', 'equity', NULL, false, false, false),
  ('3100', 'رأس مال الشركاء', 'Owners'' capital', 'equity', '3000', true, false, false),
  ('3200', 'الحسابات الجارية للشركاء', 'Owners'' current accounts / drawings', 'equity', '3000', true, false, false),
  ('3300', 'الأرباح المحتجزة', 'Retained earnings', 'equity', '3000', true, false, false),
  ('3900', 'حقوق ملكية الأرصدة الافتتاحية', 'Opening balance equity (temporary)', 'equity', '3000', true, false, false),
  ('4000', 'الإيرادات', 'Revenue', 'revenue', NULL, false, false, false),
  ('4100', 'إيرادات – مستلزمات المسابح', 'Revenue – pool supplies', 'revenue', '4000', true, false, false),
  ('4200', 'إيرادات – إنشاء المسابح', 'Revenue – pool construction', 'revenue', '4000', true, false, false),
  ('4300', 'إيرادات – صيانة المسابح', 'Revenue – pool maintenance', 'revenue', '4000', true, false, false),
  ('4400', 'إيرادات – تنظيف المسابح', 'Revenue – pool cleaning', 'revenue', '4000', true, false, false),
  ('4900', 'إيرادات أخرى', 'Other income', 'revenue', '4000', true, false, false),
  ('5000', 'تكلفة المبيعات', 'Cost of sales', 'expense', NULL, false, false, false),
  ('5100', 'تكلفة المبيعات – مستلزمات المسابح', 'Cost of sales – pool supplies', 'expense', '5000', true, false, false),
  ('5200', 'تكلفة المبيعات – إنشاء المسابح', 'Cost of sales – pool construction', 'expense', '5000', true, false, false),
  ('5300', 'تكلفة المبيعات – صيانة المسابح', 'Cost of sales – pool maintenance', 'expense', '5000', true, false, false),
  ('5400', 'تكلفة المبيعات – تنظيف المسابح', 'Cost of sales – pool cleaning', 'expense', '5000', true, false, false),
  ('5600', 'تسويات المخزون', 'Inventory adjustments (gains and losses)', 'expense', '5000', true, false, false),
  ('5700', 'شطب المخزون التالف', 'Defective stock write-offs', 'expense', '5000', true, false, false),
  ('6000', 'المصروفات التشغيلية', 'Operating expenses', 'expense', NULL, false, false, false),
  ('6100', 'الرواتب والأجور', 'Salaries and wages', 'expense', '6000', true, false, false),
  ('6110', 'رسوم التأشيرات والعمالة', 'Visas, labour and staff fees', 'expense', '6000', true, false, false),
  ('6120', 'مصروف مكافأة نهاية الخدمة', 'End-of-service benefits expense', 'expense', '6000', true, false, false),
  ('6200', 'الإيجار', 'Rent', 'expense', '6000', true, false, false),
  ('6210', 'الكهرباء والماء', 'Electricity and water', 'expense', '6000', true, false, false),
  ('6220', 'الهاتف والإنترنت', 'Telephone and internet', 'expense', '6000', true, false, false),
  ('6300', 'وقود المركبات', 'Vehicle fuel', 'expense', '6000', true, false, false),
  ('6310', 'صيانة وترخيص المركبات', 'Vehicle maintenance and registration', 'expense', '6000', true, false, false),
  ('6400', 'الإصلاحات والصيانة', 'Repairs and maintenance', 'expense', '6000', true, false, false),
  ('6500', 'القرطاسية والطباعة', 'Office supplies and printing', 'expense', '6000', true, false, false),
  ('6510', 'التسويق والإعلان', 'Marketing and advertising', 'expense', '6000', true, false, false),
  ('6600', 'الرسوم البنكية', 'Bank charges', 'expense', '6000', true, false, false),
  ('6610', 'عمولات البطاقات', 'Card merchant fees', 'expense', '6000', true, false, false),
  ('6700', 'الرسوم الحكومية والرخصة التجارية', 'Government fees and trade licence', 'expense', '6000', true, false, false),
  ('6710', 'التأمين', 'Insurance', 'expense', '6000', true, false, false),
  ('6720', 'الأتعاب المهنية', 'Professional fees', 'expense', '6000', true, false, false),
  ('6800', 'الإهلاك', 'Depreciation', 'expense', '6000', true, false, false),
  ('6900', 'مصروفات نثرية', 'Petty cash expenses (general)', 'expense', '6000', true, false, false),
  ('6910', 'عجز وزيادة النقدية', 'Cash over / short', 'expense', '6000', true, false, false),
  ('6990', 'مصروفات متنوعة', 'Miscellaneous expenses', 'expense', '6000', true, false, false)
    ) AS v(code, name_ar, name_en, account_type, parent_code, is_postable, is_control, is_contra)
    ORDER BY code
  LOOP
    INSERT INTO gl.accounts (code, name_ar, name_en, account_type, parent_id, is_postable, is_control,
                             is_contra)
    VALUES (r.code, r.name_ar, r.name_en, r.account_type,
            (SELECT id FROM gl.accounts WHERE code = r.parent_code), r.is_postable, r.is_control,
            r.is_contra);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------
-- The account used for each event (posting map, docs/accounting/posting-map.md)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE gl.account_mappings (
  key            text PRIMARY KEY CHECK (key IN (
                   'ar_control', 'ap_control', 'customer_advances', 'vat_output', 'vat_input',
                   'inventory', 'inventory_defective', 'stock_adjustments', 'write_off',
                   'cash_over_short', 'cash_in_safe', 'opening_balance_equity')),
  account_id     bigint NOT NULL REFERENCES gl.accounts (id),
  -- What kind of account the event needs (fixed): the type, and whether it is a control account.
  required_type  text NOT NULL CHECK (required_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  needs_control  boolean NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     bigint NOT NULL REFERENCES auth.users (id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint NOT NULL REFERENCES auth.users (id),
  row_version    integer NOT NULL DEFAULT 1
);
CREATE INDEX account_mappings_account_ix ON gl.account_mappings (account_id);

-- Why an account is in use, or NULL. An account in use keeps its type, its header/postable
-- choice, its control flag and its active state. Replaced by later migrations as more things
-- point at accounts (0009: lines of business, payment methods, reason codes; 0011: postings).
CREATE FUNCTION gl.account_in_use(p_account_id bigint) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM gl.account_mappings WHERE account_id = p_account_id)
              THEN 'event_link' END
$$;

CREATE FUNCTION gl.mapping_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_account gl.accounts;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.key, NEW.required_type, NEW.needs_control)
                          IS DISTINCT FROM (OLD.key, OLD.required_type, OLD.needs_control) THEN
    RAISE EXCEPTION 'Only the account of an event link can change' USING ERRCODE = 'AP003';
  END IF;
  SELECT * INTO v_account FROM gl.accounts WHERE id = NEW.account_id;
  IF NOT v_account.is_active OR NOT v_account.is_postable
     OR v_account.account_type <> NEW.required_type OR v_account.is_control <> NEW.needs_control THEN
    RAISE EXCEPTION 'Event % needs an active, postable % account%', NEW.key, NEW.required_type,
      CASE WHEN NEW.needs_control THEN ' marked as control' ELSE ' that is not a control account' END
      USING ERRCODE = 'AP011', HINT = 'MAPPING_ACCOUNT_INVALID';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_mapping_rules BEFORE INSERT OR UPDATE ON gl.account_mappings
  FOR EACH ROW EXECUTE FUNCTION gl.mapping_rules();

SELECT sys.add_touch('gl.account_mappings');
SELECT audit.enable_for('gl.account_mappings', p_keys => ARRAY['key']);
SELECT sys.forbid_delete('gl.account_mappings');

INSERT INTO gl.account_mappings (key, account_id, required_type, needs_control)
SELECT m.key, a.id, m.required_type, m.needs_control
  FROM (VALUES ('ar_control', '1210', 'asset', true),
               ('ap_control', '2110', 'liability', true),
               ('customer_advances', '2120', 'liability', false),
               ('vat_output', '2130', 'liability', false),
               ('vat_input', '1410', 'asset', false),
               ('inventory', '1310', 'asset', false),
               ('inventory_defective', '1320', 'asset', false),
               ('stock_adjustments', '5600', 'expense', false),
               ('write_off', '5700', 'expense', false),
               ('cash_over_short', '6910', 'expense', false),
               ('cash_in_safe', '1120', 'asset', false),
               ('opening_balance_equity', '3900', 'equity', false))
       AS m(key, code, required_type, needs_control)
  JOIN gl.accounts AS a ON a.code = m.code;

-- ---------------------------------------------------------------------------------------------
-- Monthly accounting periods (decisions 0016, 0035): open → closed → locked; locked is final
-- ---------------------------------------------------------------------------------------------
CREATE TABLE gl.periods (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_start  date NOT NULL UNIQUE,
  period_end    date NOT NULL,
  fiscal_year   smallint NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'locked')),
  closed_at     timestamptz,
  closed_by     bigint REFERENCES auth.users (id),
  locked_at     timestamptz,
  locked_by     bigint REFERENCES auth.users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    bigint NOT NULL REFERENCES auth.users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    bigint NOT NULL REFERENCES auth.users (id),
  row_version   integer NOT NULL DEFAULT 1,
  CONSTRAINT periods_month_ck CHECK (
    extract(day FROM period_start) = 1
    AND period_end = (period_start + interval '1 month' - interval '1 day')::date),
  -- Fiscal year January–December (decision 0035).
  CONSTRAINT periods_year_ck CHECK (fiscal_year = extract(year FROM period_start)),
  CONSTRAINT periods_closed_ck CHECK ((status = 'open') = (closed_at IS NULL)
                                     AND (closed_at IS NULL) = (closed_by IS NULL)),
  CONSTRAINT periods_locked_ck CHECK ((status = 'locked') = (locked_at IS NOT NULL)
                                     AND (locked_at IS NULL) = (locked_by IS NULL)),
  CONSTRAINT periods_no_overlap EXCLUDE USING gist (daterange(period_start, period_end, '[]') WITH &&)
);

CREATE FUNCTION gl.period_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- One status change at a time, so the month-order checks below see a settled picture.
  PERFORM pg_advisory_xact_lock(hashtext('gl.periods'));
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.closed_at IS NOT NULL OR NEW.locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new month always starts open' USING ERRCODE = 'AP011', HINT = 'PERIOD_STATUS_STEP';
    END IF;
    IF EXISTS (SELECT 1 FROM gl.periods)
       AND NEW.period_start <> (SELECT (max(period_start) + interval '1 month')::date FROM gl.periods) THEN
      RAISE EXCEPTION 'Months are added one after another, with no gaps' USING ERRCODE = 'AP011', HINT = 'PERIOD_GAP';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.period_start, NEW.period_end, NEW.fiscal_year)
     IS DISTINCT FROM (OLD.period_start, OLD.period_end, OLD.fiscal_year) THEN
    RAISE EXCEPTION 'The dates of a month cannot change' USING ERRCODE = 'AP003';
  END IF;
  -- Who and when are always set here, from the request context and server time.
  NEW.closed_at := OLD.closed_at;
  NEW.closed_by := OLD.closed_by;
  NEW.locked_at := OLD.locked_at;
  NEW.locked_by := OLD.locked_by;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'locked' THEN
    RAISE EXCEPTION 'A locked month can never be reopened' USING ERRCODE = 'AP011', HINT = 'PERIOD_LOCKED';
  END IF;

  IF OLD.status = 'open' AND NEW.status = 'closed' THEN
    IF NEW.period_end >= sys.business_date(now()) THEN
      RAISE EXCEPTION 'A month can be closed only after it has ended' USING ERRCODE = 'AP011', HINT = 'PERIOD_NOT_ENDED';
    END IF;
    IF EXISTS (SELECT 1 FROM gl.periods WHERE period_start < NEW.period_start AND status = 'open') THEN
      RAISE EXCEPTION 'Close the earlier months first' USING ERRCODE = 'AP011', HINT = 'PERIOD_ORDER';
    END IF;
    NEW.closed_at := now();
    NEW.closed_by := sys.require_user();
  ELSIF OLD.status = 'closed' AND NEW.status = 'open' THEN
    IF sys.ctx_reason() IS NULL THEN
      RAISE EXCEPTION 'Reopening a month needs a reason' USING ERRCODE = 'AP011', HINT = 'REASON_REQUIRED';
    END IF;
    IF EXISTS (SELECT 1 FROM gl.periods WHERE period_start > NEW.period_start AND status <> 'open') THEN
      RAISE EXCEPTION 'Reopen the later months first' USING ERRCODE = 'AP011', HINT = 'PERIOD_ORDER';
    END IF;
    NEW.closed_at := NULL;
    NEW.closed_by := NULL;
  ELSIF OLD.status = 'closed' AND NEW.status = 'locked' THEN
    IF EXISTS (SELECT 1 FROM gl.periods WHERE period_start < NEW.period_start AND status <> 'locked') THEN
      RAISE EXCEPTION 'Lock the earlier months first' USING ERRCODE = 'AP011', HINT = 'PERIOD_ORDER';
    END IF;
    NEW.locked_at := now();
    NEW.locked_by := sys.require_user();
  ELSE
    RAISE EXCEPTION 'A month goes from open to closed to locked, one step at a time'
      USING ERRCODE = 'AP011', HINT = 'PERIOD_STATUS_STEP';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_period_rules BEFORE INSERT OR UPDATE ON gl.periods
  FOR EACH ROW EXECUTE FUNCTION gl.period_rules();

SELECT sys.add_touch('gl.periods');
SELECT audit.enable_for('gl.periods');
SELECT sys.forbid_delete('gl.periods');

-- Creates the missing months up to `p_months_ahead` months after the current one (Asia/Dubai),
-- starting from January of the current year when there are none yet. Run by this migration and
-- by the server every day (decision 0016: months always exist 3 months ahead).
CREATE FUNCTION gl.ensure_periods(p_months_ahead integer DEFAULT 3) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_today date := sys.business_date(now());
  v_target date;
  v_next date;
  v_created integer := 0;
BEGIN
  PERFORM sys.require_user();
  IF p_months_ahead IS NULL OR p_months_ahead NOT BETWEEN 0 AND 24 THEN
    RAISE EXCEPTION 'Months ahead must be from 0 to 24' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('gl.periods'));
  v_target := (date_trunc('month', v_today) + make_interval(months => p_months_ahead))::date;
  SELECT (max(period_start) + interval '1 month')::date INTO v_next FROM gl.periods;
  v_next := coalesce(v_next, make_date(extract(year FROM v_today)::integer, 1, 1));
  WHILE v_next <= v_target LOOP
    INSERT INTO gl.periods (period_start, period_end, fiscal_year)
    VALUES (v_next, (v_next + interval '1 month' - interval '1 day')::date,
            extract(year FROM v_next)::smallint);
    v_created := v_created + 1;
    v_next := (v_next + interval '1 month')::date;
  END LOOP;
  RETURN v_created;
END $$;

SELECT gl.ensure_periods(3);

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON gl.accounts, gl.account_mappings, gl.periods TO artepool_api;
GRANT INSERT (code, name_ar, name_en, account_type, parent_id, is_postable, is_control, is_contra, is_active)
  ON gl.accounts TO artepool_api;
GRANT UPDATE (code, name_ar, name_en, account_type, parent_id, is_postable, is_control, is_contra, is_active)
  ON gl.accounts TO artepool_api;
GRANT UPDATE (account_id) ON gl.account_mappings TO artepool_api;
GRANT UPDATE (status) ON gl.periods TO artepool_api;
GRANT EXECUTE ON FUNCTION gl.account_in_use(bigint), gl.ensure_periods(integer) TO artepool_api;
