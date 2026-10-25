-- 0038_device_label_printer.sql
-- Purpose: decision 0096. The label printer of each PC is kept on the server, in
-- auth.devices.printer_config -> 'label' (audited like every change to a device), so it survives a
-- reinstall: the Windows printer's name, its dots per inch, how wide it prints and the X/Y offset
-- (mm) found with the test label. The database checks the values; the owner sets them in
-- Settings → Devices (system.devices.manage).
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0038: label printer per PC (decision 0096)');

-- A label printer setting: absent, or an object with exactly these keys and sensible values.
CREATE FUNCTION auth.valid_label_printer(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  -- coalesce: a missing value must fail the check, not leave it unknown (which a CHECK accepts).
  SELECT p IS NULL OR coalesce(
    jsonb_typeof(p) = 'object'
    AND p ?& ARRAY['printer', 'dpi', 'printableWidthMm', 'offsetXMm', 'offsetYMm']
    AND (SELECT count(*) FROM jsonb_object_keys(p) k
          WHERE k NOT IN ('printer', 'dpi', 'printableWidthMm', 'offsetXMm', 'offsetYMm')) = 0
    AND jsonb_typeof(p -> 'printer') IN ('string', 'null')
    AND coalesce(length(p ->> 'printer') BETWEEN 1 AND 256, true)
    AND jsonb_typeof(p -> 'dpi') = 'number' AND (p ->> 'dpi')::numeric IN (203, 300)
    AND jsonb_typeof(p -> 'printableWidthMm') = 'number'
    AND (p ->> 'printableWidthMm')::numeric BETWEEN 20 AND 120
    AND jsonb_typeof(p -> 'offsetXMm') = 'number' AND (p ->> 'offsetXMm')::numeric BETWEEN -10 AND 10
    AND jsonb_typeof(p -> 'offsetYMm') = 'number' AND (p ->> 'offsetYMm')::numeric BETWEEN -10 AND 10,
    false)
$$;

ALTER TABLE auth.devices ADD CONSTRAINT devices_label_printer_ck
  CHECK (auth.valid_label_printer(printer_config -> 'label'));

-- The API writes devices, so it runs the check.
GRANT EXECUTE ON FUNCTION auth.valid_label_printer(jsonb) TO artepool_api;
