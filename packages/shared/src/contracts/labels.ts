/**
 * The barcode label design (decision 0097): which elements the label shows, in which order, how big,
 * bold or not and where; the barcode's height (never below the minimum a scanner needs); the
 * language of the label's fixed words; margins and a border. One base design for every size, with an
 * optional override per size (by its code). Saved as versions of the `barcode_label` print
 * template, by the owner only.
 */
import { z } from 'zod';
import { IdText } from './auth';

/** Everything a label can show. The digits under the bars belong to the barcode. */
export const LABEL_ELEMENTS = [
  'nameAr',
  'nameEn',
  'pack',
  'barcode',
  'itemCode',
  'price',
  'vatNote',
  'expiry',
  'batch',
  'printDate',
  'shopName',
  'customText',
] as const;
export type LabelElement = (typeof LABEL_ELEMENTS)[number];

export const LABEL_SIZES = ['s', 'm', 'l'] as const;
export type LabelTextSize = (typeof LABEL_SIZES)[number];
export const LABEL_ALIGNS = ['right', 'center', 'left'] as const;
export type LabelAlign = (typeof LABEL_ALIGNS)[number];
export const LABEL_LANGUAGES = ['ar', 'en', 'both'] as const;
export type LabelLanguage = (typeof LABEL_LANGUAGES)[number];

/** The barcode can never be smaller than this (decision 0097): bars 5 mm high at least. */
export const LABEL_BARCODE_MIN_HEIGHT_MM = 5;
export const LABEL_BARCODE_MAX_HEIGHT_MM = 20;

export const LabelElementStyle = z.object({
  show: z.boolean(),
  size: z.enum(LABEL_SIZES),
  bold: z.boolean(),
  align: z.enum(LABEL_ALIGNS),
});
export type LabelElementStyle = z.infer<typeof LabelElementStyle>;

const ElementStyles = z.object(
  Object.fromEntries(LABEL_ELEMENTS.map((e) => [e, LabelElementStyle])) as Record<
    LabelElement,
    typeof LabelElementStyle
  >,
);

const BarcodeHeight = z
  .number()
  .min(LABEL_BARCODE_MIN_HEIGHT_MM)
  .max(LABEL_BARCODE_MAX_HEIGHT_MM)
  .refine((v) => Math.abs(v * 2 - Math.round(v * 2)) < 1e-9, 'half millimetres');

/** What one size changes from the base design: elements shown or hidden, their size, the bars. */
export const LabelSizeOverride = z.object({
  elements: z
    .object(
      Object.fromEntries(
        LABEL_ELEMENTS.map((e) => [
          e,
          z.object({ show: z.boolean().optional(), size: z.enum(LABEL_SIZES).optional() }),
        ]),
      ) as Record<
        LabelElement,
        z.ZodObject<{
          show: z.ZodOptional<z.ZodBoolean>;
          size: z.ZodOptional<z.ZodEnum<{ s: 's'; m: 'm'; l: 'l' }>>;
        }>
      >,
    )
    .partial(),
  barcodeHeightMm: BarcodeHeight.optional(),
});
export type LabelSizeOverride = z.infer<typeof LabelSizeOverride>;

export const LabelDesign = z.object({
  /** The elements, top to bottom; each one exactly once. */
  order: z
    .array(z.enum(LABEL_ELEMENTS))
    .length(LABEL_ELEMENTS.length)
    .refine((order) => new Set(order).size === LABEL_ELEMENTS.length, 'each element once'),
  elements: ElementStyles,
  barcode: z.object({
    heightMm: BarcodeHeight,
    /** The code in digits under the bars. */
    showDigits: z.boolean(),
    /** "auto": a real EAN-13 / UPC-A / EAN-8 stays so; "code128": always Code 128. */
    symbology: z.enum(['auto', 'code128']),
  }),
  /** The label's fixed words (currency, "incl. VAT", expiry, batch): Arabic, English or both. */
  language: z.enum(LABEL_LANGUAGES),
  /** "incl. VAT" under the price: always, when the item's price includes VAT, or never. */
  vatNote: z.enum(['always', 'whenIncluded', 'never']),
  customText: z.string().trim().max(60),
  marginsMm: z.object({
    side: z.number().min(0.5).max(4),
    edge: z.number().min(0.5).max(4),
  }),
  border: z.boolean(),
  /** Per label size (its code, e.g. "40X30"); a size not listed uses the base design. */
  overrides: z.record(z.string().regex(/^[A-Za-z0-9._-]{1,32}$/), LabelSizeOverride),
});
export type LabelDesign = z.infer<typeof LabelDesign>;

const style = (patch: Partial<LabelElementStyle> = {}): LabelElementStyle => ({
  show: false,
  size: 'm',
  bold: false,
  align: 'center',
  ...patch,
});

/**
 * The design every installation starts with (and "Reset to the default design"): the Arabic name,
 * the barcode with its digits, the price and "incl. VAT" when the price includes it; expiry and
 * batch show when typed at printing time.
 */
export function defaultLabelDesign(): LabelDesign {
  return {
    order: [...LABEL_ELEMENTS],
    elements: {
      nameAr: style({ show: true, bold: true }),
      nameEn: style({ size: 's' }),
      pack: style({ size: 's' }),
      barcode: style({ show: true }),
      itemCode: style({ size: 's' }),
      price: style({ show: true, bold: true }),
      vatNote: style({ show: true, size: 's' }),
      expiry: style({ show: true, size: 's' }),
      batch: style({ show: true, size: 's' }),
      printDate: style({ size: 's' }),
      shopName: style({ size: 's' }),
      customText: style({ size: 's' }),
    },
    barcode: { heightMm: 10, showDigits: true, symbology: 'auto' },
    language: 'ar',
    vatNote: 'whenIncluded',
    customText: '',
    marginsMm: { side: 1, edge: 1 },
    border: false,
    overrides: {},
  };
}

/** A stored design, or the default one when it is missing or from an older form. */
export function readLabelDesign(raw: unknown): LabelDesign {
  const parsed = LabelDesign.safeParse(raw);
  return parsed.success ? parsed.data : defaultLabelDesign();
}

/** The design for one size: the base design with that size's override applied. */
export function designForSize(design: LabelDesign, sizeCode: string): LabelDesign {
  const override = design.overrides[sizeCode];
  if (!override) return design;
  const elements = { ...design.elements };
  for (const element of LABEL_ELEMENTS) {
    const change = override.elements[element];
    if (change) elements[element] = { ...elements[element], ...change };
  }
  return {
    ...design,
    elements,
    barcode: { ...design.barcode, heightMm: override.barcodeHeightMm ?? design.barcode.heightMm },
  };
}

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

export interface LabelDesignResponse {
  versionId: string;
  versionNo: number;
  savedAt: string;
  savedBy: { displayNameAr: string; displayNameEn: string } | null;
  design: LabelDesign;
  /** The shop's name for the "Shop name" element. */
  shopName: { ar: string; en: string };
  canEdit: boolean;
}

export const SaveLabelDesignRequest = z.object({
  design: LabelDesign,
  note: z.string().trim().max(200).optional(),
  /** The version the owner started from: saving over a newer one is refused (STALE_VERSION). */
  basedOnVersionId: IdText,
});
export type SaveLabelDesignRequest = z.infer<typeof SaveLabelDesignRequest>;
