-- 0040_label_design.sql
-- Purpose: decision 0097. (1) Items get an optional sale pack text in Arabic and English (e.g.
-- "كيس 25 كجم" / "25 kg bag") for the label's "Sale pack" element; without it the label prints the
-- item's unit. (2) The barcode label template gets the default label design as a new version: label
-- designs are versions of the `barcode_label` print template (owner only, never changed later,
-- audited), read by everyone who prints labels.
-- Never edit this file after it has been applied anywhere. Add a new migration instead.

SELECT sys.set_context(1, p_reason => 'migration 0040: sale pack on items, default label design (decision 0097)');

ALTER TABLE md.items
  ADD COLUMN pack_ar text CHECK (pack_ar IS NULL OR (btrim(pack_ar) <> '' AND length(pack_ar) <= 40)),
  ADD COLUMN pack_en text CHECK (pack_en IS NULL OR (btrim(pack_en) <> '' AND length(pack_en) <= 40));
GRANT UPDATE (pack_ar, pack_en) ON md.items TO artepool_api;
GRANT INSERT (pack_ar, pack_en) ON md.items TO artepool_api;

-- The default design (shared/contracts/labels.ts, defaultLabelDesign): the Arabic name, the barcode
-- with its digits, the price, "incl. VAT" when the price includes it; expiry and batch when typed.
INSERT INTO sys.print_template_versions (template_id, settings, note)
SELECT id, jsonb_build_object(
         'order', jsonb_build_array('nameAr', 'nameEn', 'pack', 'barcode', 'itemCode', 'price', 'vatNote',
                                    'expiry', 'batch', 'printDate', 'shopName', 'customText'),
         'elements', jsonb_build_object(
           'nameAr',     jsonb_build_object('show', true,  'size', 'm', 'bold', true,  'align', 'center'),
           'nameEn',     jsonb_build_object('show', false, 'size', 's', 'bold', false, 'align', 'center'),
           'pack',       jsonb_build_object('show', false, 'size', 's', 'bold', false, 'align', 'center'),
           'barcode',    jsonb_build_object('show', true,  'size', 'm', 'bold', false, 'align', 'center'),
           'itemCode',   jsonb_build_object('show', false, 'size', 's', 'bold', false, 'align', 'center'),
           'price',      jsonb_build_object('show', true,  'size', 'm', 'bold', true,  'align', 'center'),
           'vatNote',    jsonb_build_object('show', true,  'size', 's', 'bold', false, 'align', 'center'),
           'expiry',     jsonb_build_object('show', true,  'size', 's', 'bold', false, 'align', 'center'),
           'batch',      jsonb_build_object('show', true,  'size', 's', 'bold', false, 'align', 'center'),
           'printDate',  jsonb_build_object('show', false, 'size', 's', 'bold', false, 'align', 'center'),
           'shopName',   jsonb_build_object('show', false, 'size', 's', 'bold', false, 'align', 'center'),
           'customText', jsonb_build_object('show', false, 'size', 's', 'bold', false, 'align', 'center')),
         'barcode', jsonb_build_object('heightMm', 10, 'showDigits', true, 'symbology', 'auto'),
         'language', 'ar',
         'vatNote', 'whenIncluded',
         'customText', '',
         'marginsMm', jsonb_build_object('side', 1, 'edge', 1),
         'border', false,
         'overrides', '{}'::jsonb),
       'Default label design (decision 0097)'
  FROM sys.print_templates WHERE doc_kind = 'barcode_label';
UPDATE sys.print_templates t
   SET current_version_id = (SELECT max(v.id) FROM sys.print_template_versions v WHERE v.template_id = t.id)
 WHERE doc_kind = 'barcode_label';
