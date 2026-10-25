/**
 * The barcode label as the owner designed it (decision 0097): the current design from the server,
 * what an item puts on its label, and one function that lays out and draws a label for a size and
 * this PC's label printer. The labels screen, the designer's previews and batch printing all use it,
 * so what the preview shows is what prints.
 */
import { useQuery } from '@tanstack/react-query';
import {
  designForSize,
  type ItemDetail,
  type LabelDesign,
  type LabelDesignResponse,
  type LabelPrinterConfig,
  type LabelSizeItem,
  type UnitItem,
} from '@artepool/shared/contracts';
import { useApi } from '../../../api/hooks';
import { formatDate } from '../../../lib/format';
import { money, priceBoth } from '../../masterdata/format';
import {
  layoutLabel,
  type LabelContent,
  type LabelWords,
  type LayoutResult,
  type Measurer,
} from './layout';
import { renderLabel, type LabelImage } from './render';

export const LABEL_DESIGN_KEY = ['label-design'] as const;

/** The current label design, the shop's name, and whether this person may change the design. */
export function useLabelDesign() {
  const api = useApi();
  return useQuery({
    queryKey: LABEL_DESIGN_KEY,
    queryFn: () => api.get<LabelDesignResponse>('/api/v1/label-design'),
  });
}

/** What is typed when printing (decision 0097): only printed when the design shows them. */
export interface PrintExtras {
  /** `YYYY-MM-DD` from the date field, or empty. */
  expiry: string;
  batch: string;
}

/** A date as people read it on a label: 31/05/2027. */
const labelDate = (isoDay: string) => formatDate(`${isoDay}T12:00:00Z`);

/** What an item puts on its label: names, code, barcode, sale pack, price with VAT, the extras. */
export function labelContent(
  item: Pick<
    ItemDetail,
    'nameAr' | 'nameEn' | 'code' | 'primaryBarcode' | 'price' | 'packAr' | 'packEn' | 'unitId'
  >,
  opts: {
    design: LabelDesign;
    shopName: { ar: string; en: string } | null;
    units: UnitItem[];
    /** The item's VAT rate in basis points; without it there is no price. */
    rateBp: number | undefined;
    withPrice: boolean;
    extras: PrintExtras;
    today: string;
  },
): LabelContent {
  const unit = opts.units.find((u) => u.id === item.unitId);
  // In both languages: each element prints the one(s) the design asks for (decision 0101).
  const pack = {
    ar: item.packAr ?? unit?.nameAr ?? null,
    en: item.packEn ?? unit?.nameEn ?? null,
  };
  const gross =
    opts.withPrice && item.price && opts.rateBp !== undefined
      ? priceBoth(BigInt(item.price.price4dp), item.price.includesVat, opts.rateBp).grossFils
      : null;
  return {
    nameAr: item.nameAr,
    nameEn: item.nameEn,
    itemCode: item.code,
    barcodeData: item.primaryBarcode ?? item.code,
    pack,
    shopName: opts.shopName,
    price:
      gross !== null
        ? { amount: money(gross), includesVat: item.price?.includesVat ?? false }
        : null,
    expiry: opts.extras.expiry ? labelDate(opts.extras.expiry) : null,
    batch: opts.extras.batch.trim() || null,
    printDate: labelDate(opts.today),
  };
}

/** A4 label sheets print through the print dialog on an office printer: drawn finely. */
export const SHEET_DPI = 300;

/** Lays out and draws one label for a size: at this PC's label printer dots, or finely for A4. */
export function drawLabel(input: {
  size: Pick<LabelSizeItem, 'code' | 'widthMm' | 'heightMm'>;
  printer: LabelPrinterConfig;
  sheet?: boolean;
  design: LabelDesign;
  content: LabelContent;
  words: LabelWords;
  measurer: Measurer;
}): { layout: LayoutResult; image: LabelImage | null } {
  const { size, printer, sheet } = input;
  const geometry = sheet
    ? {
        widthMm: size.widthMm,
        heightMm: size.heightMm,
        dpi: SHEET_DPI,
        printableWidthMm: size.widthMm,
      }
    : {
        widthMm: size.widthMm,
        heightMm: size.heightMm,
        dpi: printer.dpi,
        printableWidthMm: printer.printableWidthMm,
      };
  const layout = layoutLabel(
    geometry,
    designForSize(input.design, size.code),
    input.content,
    input.words,
    input.measurer,
  );
  if (!layout.ok) return { layout, image: null };
  const dots = (mm: number) => Math.round((mm * geometry.dpi) / 25.4);
  // The printer's calibration moves the drawing on a roll; a sheet is placed by the office printer.
  const offset = sheet
    ? { x: 0, y: 0 }
    : { x: dots(printer.offsetXMm), y: dots(printer.offsetYMm) };
  try {
    return { layout, image: renderLabel(layout, offset) };
  } catch {
    // No canvas to draw on (only in some test browsers): laid out, not drawn.
    return { layout, image: null };
  }
}
