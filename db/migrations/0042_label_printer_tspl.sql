-- 0042_label_printer_tspl.sql
-- Purpose: decision 0100. For direct (RAW TSPL) printing, the label printer of a PC may also hold
-- the gap between labels on the roll (`gapMm`, 0–10 mm, one decimal) and whether the print is
-- turned round (`flip`, TSPL DIRECTION 0 instead of 1). Settings saved before keep working: the new
-- keys are optional.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0042: label printer gap and direction for TSPL (decision 0100)');

CREATE OR REPLACE FUNCTION auth.valid_label_printer(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  -- coalesce: a missing value must fail the check, not leave it unknown (which a CHECK accepts).
  SELECT p IS NULL OR coalesce(
    jsonb_typeof(p) = 'object'
    AND p ?& ARRAY['printer', 'dpi', 'printableWidthMm', 'offsetXMm', 'offsetYMm']
    AND (SELECT count(*) FROM jsonb_object_keys(p) k
          WHERE k NOT IN ('printer', 'dpi', 'printableWidthMm', 'offsetXMm', 'offsetYMm',
                          'darkness', 'speed', 'mode', 'gapMm', 'flip')) = 0
    AND jsonb_typeof(p -> 'printer') IN ('string', 'null')
    AND coalesce(length(p ->> 'printer') BETWEEN 1 AND 256, true)
    AND jsonb_typeof(p -> 'dpi') = 'number' AND (p ->> 'dpi')::numeric IN (203, 300)
    AND jsonb_typeof(p -> 'printableWidthMm') = 'number'
    AND (p ->> 'printableWidthMm')::numeric BETWEEN 20 AND 120
    AND jsonb_typeof(p -> 'offsetXMm') = 'number' AND (p ->> 'offsetXMm')::numeric BETWEEN -10 AND 10
    AND jsonb_typeof(p -> 'offsetYMm') = 'number' AND (p ->> 'offsetYMm')::numeric BETWEEN -10 AND 10
    AND (NOT p ? 'darkness' OR (jsonb_typeof(p -> 'darkness') = 'number'
         AND (p ->> 'darkness')::numeric IN (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15)))
    AND (NOT p ? 'speed' OR (jsonb_typeof(p -> 'speed') = 'number'
         AND (p ->> 'speed')::numeric IN (1, 2, 3, 4, 5, 6)))
    AND (NOT p ? 'mode' OR p ->> 'mode' IN ('driver', 'tspl'))
    AND (NOT p ? 'gapMm' OR (jsonb_typeof(p -> 'gapMm') = 'number'
         AND (p ->> 'gapMm')::numeric BETWEEN 0 AND 10
         AND (p ->> 'gapMm')::numeric * 10 = round((p ->> 'gapMm')::numeric * 10)))
    AND (NOT p ? 'flip' OR jsonb_typeof(p -> 'flip') = 'boolean'),
    false)
$$;
