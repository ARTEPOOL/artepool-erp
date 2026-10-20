/**
 * The barcode label layout (decisions 0096, 0097), worked out in the printer's own dots from the
 * owner's design: the shown elements top to bottom in the design's order, each at its size, bold or
 * not, aligned right, centre or left. When a size is too small for the design as drawn, the bars get
 * shorter (never below 5 mm) and then the letters smaller (never below a readable 2 mm); the Arabic
 * name keeps to 2 lines (1 when squeezed to the end) and ends in "…" if it must. Everything stays
 * inside the printer's printable width, centred on the label; nothing ever overlaps; a label that
 * still does not fit is refused, never printed broken. Pure: text is measured by the caller (a
 * canvas, or a test).
 */
import {
  elementLanguage,
  LABEL_BARCODE_MIN_HEIGHT_MM,
  type LabelAlign,
  type LabelDesign,
  type LabelElement,
  type LabelLanguage,
  type LabelTextSize,
} from '@artepool/shared/contracts';
import { barcodeFor, barRects, moduleDots } from './barcode';

export interface LabelGeometry {
  widthMm: number;
  heightMm: number;
  /** Printer dots per inch (203 or 300). */
  dpi: number;
  /** How wide the printer prints (48 mm on a 2-inch printer); the content never goes beyond it. */
  printableWidthMm: number;
}

/** What goes on the label for one item (empty = that element is left out). */
export interface LabelContent {
  nameAr: string;
  nameEn: string | null;
  itemCode: string;
  /** What the barcode holds (the main barcode, else the item code). */
  barcodeData: string;
  /** The sale pack ("كيس 25 كجم" / "25 kg bag"), else the unit's name, in each language. */
  pack: { ar: string | null; en: string | null };
  shopName: { ar: string; en: string } | null;
  /** The price with VAT, "120.00" (Western digits); null = no price. */
  price: { amount: string; includesVat: boolean } | null;
  expiry: string | null;
  batch: string | null;
  printDate: string | null;
}

/** The label's fixed words in both languages (from the translations). */
export interface LabelWords {
  currency: { ar: string; en: string };
  vat: { ar: string; en: string };
  expiry: { ar: string; en: string };
  batch: { ar: string; en: string };
}

/** Measures text the way it will be drawn (a canvas in the app; an estimate in tests). */
export interface Measurer {
  width(text: string, fontDots: number, bold: boolean): number;
  /** How far the letters of this script rise above and drop below the baseline. */
  extent(fontDots: number, script: 'arabic' | 'latin'): { ascent: number; descent: number };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One line of text: drawn at `x` with `align` (canvas textAlign) on `baseline`. */
export interface TextLine {
  part: LabelElement | 'digits';
  text: string;
  x: number;
  baseline: number;
  fontDots: number;
  bold: boolean;
  dir: 'rtl' | 'ltr';
  align: LabelAlign;
  box: Box;
}

/** A price line: the currency and the number as separate runs (the number always left to right). */
export interface PriceLine {
  runs: { text: string; x: number; dir: 'rtl' | 'ltr' }[];
  baseline: number;
  fontDots: number;
  bold: boolean;
  box: Box;
}

export interface LabelLayout {
  ok: true;
  widthDots: number;
  heightDots: number;
  /** Where content may go: the printable width minus the margins, centred on the label. */
  content: Box;
  texts: TextLine[];
  /**
   * The bars (`box`: the bars alone, inside the content area) and their quiet zones (`quiet`): blank,
   * they may reach into the side margin but stay `QUIET_EDGE_MM` from the label's edge, or inside
   * the border when there is one (decision 0098).
   */
  bars: {
    rects: { x: number; w: number }[];
    y: number;
    h: number;
    moduleDots: number;
    box: Box;
    quiet: { x: number; w: number };
  };
  prices: PriceLine[];
  border: Box | null;
  /** True when the design had to be made smaller to fit this size. */
  fitted: boolean;
}

export type LayoutResult =
  LabelLayout | { ok: false; reason: 'too_small' | 'barcode_too_long' | 'cannot_encode' };

/** Letter sizes (mm) for small / medium / large, and the smallest a 203 dpi head prints readably. */
export const TEXT_MM: Record<LabelTextSize, number> = { s: 2, m: 2.6, l: 3.4 };
export const PRICE_MM: Record<LabelTextSize, number> = { s: 2.4, m: 3, l: 3.8 };
export const MIN_TEXT_MM = 2;
const GAP_MM = 0.5;
const TIGHT_MM = 0.3;
const BORDER_INSET_MM = 0.6;
/** The quiet zones stay at least this far from the label's edge (small sideways drift of the roll). */
export const QUIET_EDGE_MM = 0.5;

const ARABIC = /[؀-ۿ]/;
const dirOf = (text: string): 'rtl' | 'ltr' => (ARABIC.test(text) ? 'rtl' : 'ltr');
const scriptOf = (text: string) => (ARABIC.test(text) ? 'arabic' : 'latin');

/** Line height for a font size: room for the letters' own height, never less than 1.25 em. */
function lineHeight(m: Measurer, fontDots: number, script: 'arabic' | 'latin') {
  const { ascent, descent } = m.extent(fontDots, script);
  return Math.max(Math.ceil(ascent + descent) + 2, Math.ceil(fontDots * 1.25));
}

/** Baseline inside a line box, so the letters sit in its middle. */
function baselineIn(
  m: Measurer,
  top: number,
  height: number,
  fontDots: number,
  script: 'arabic' | 'latin',
) {
  const { ascent, descent } = m.extent(fontDots, script);
  return Math.round(top + (height - (ascent + descent)) / 2 + ascent);
}

/** Splits text into at most `max` lines that fit `width`, at spaces; the last line ends in "…" if cut. */
export function wrapLines(
  m: Measurer,
  text: string,
  width: number,
  fontDots: number,
  bold: boolean,
  max: number,
): { lines: string[]; cut: boolean } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { lines: [], cut: false };
  const lines: string[] = [];
  let current = '';
  let i = 0;
  for (; i < words.length; i += 1) {
    const next = current ? `${current} ${words[i]}` : words[i]!;
    if (m.width(next, fontDots, bold) <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = words[i]!;
    if (lines.length === max) break;
  }
  if (lines.length < max && current) {
    lines.push(current);
    i = words.length;
  }
  const tooWide = lines.findIndex((line) => m.width(line, fontDots, bold) > width);
  const cut = i < words.length || tooWide !== -1;
  if (!cut) return { lines, cut };
  // The line that ends in "…": the first one too wide (one very long word), else the last one;
  // it takes the rest of the text and is shortened letter by letter until it fits.
  const keep = tooWide === -1 ? lines.length - 1 : tooWide;
  let last = [...lines.slice(keep), ...words.slice(i)].join(' ');
  while (last.length > 0 && m.width(`${last}…`, fontDots, bold) > width) {
    last = last.slice(0, -1).trimEnd();
  }
  return { lines: [...lines.slice(0, keep), `${last}…`], cut };
}

/** The languages of a language choice: "both" is Arabic, then English under it (decision 0101). */
const languagesOf = (language: LabelLanguage): ('ar' | 'en')[] =>
  language === 'both' ? ['ar', 'en'] : [language];

/**
 * The texts of a text element, one per language it prints in (Arabic first), or none when it has
 * nothing to show. Each is a line of its own: two languages never share a line, so neither is cut.
 */
function textsOf(
  element: LabelElement,
  content: LabelContent,
  design: LabelDesign,
  words: LabelWords,
): string[] {
  const value = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  const each = (text: (l: 'ar' | 'en') => string | null) =>
    languagesOf(elementLanguage(design, element))
      .map(text)
      .filter((t): t is string => t !== null);
  const one = (text: string | null) => (text === null ? [] : [text]);
  switch (element) {
    case 'nameAr':
      return one(value(content.nameAr));
    case 'nameEn':
      return one(value(content.nameEn));
    case 'pack':
      return each((l) => value(content.pack[l]));
    case 'itemCode':
      return one(value(content.itemCode));
    case 'vatNote': {
      if (!content.price || design.vatNote === 'never') return [];
      if (design.vatNote === 'whenIncluded' && !content.price.includesVat) return [];
      return each((l) => words.vat[l]);
    }
    case 'expiry': {
      const expiry = value(content.expiry);
      return expiry ? each((l) => `${words.expiry[l]} ${expiry}`) : [];
    }
    case 'batch': {
      const batch = value(content.batch);
      return batch ? each((l) => `${words.batch[l]} ${batch}`) : [];
    }
    case 'printDate':
      return one(value(content.printDate));
    case 'shopName':
      return content.shopName ? each((l) => value(content.shopName![l])) : [];
    case 'customText':
      return one(value(design.customText));
    default:
      return [];
  }
}

/** One planned block, before it is placed. */
type Block =
  | {
      kind: 'text';
      part: LabelElement;
      lines: string[];
      fontDots: number;
      lineH: number;
      bold: boolean;
      align: LabelAlign;
    }
  | { kind: 'bars'; h: number; digitsFont: number; digitsH: number; align: LabelAlign }
  | {
      kind: 'price';
      lines: { currency: string; dir: 'rtl' | 'ltr' }[];
      fontDots: number;
      lineH: number;
      bold: boolean;
      align: LabelAlign;
    };

const toDots = (mm: number, dpi: number) => Math.round((mm * dpi) / 25.4);

export function layoutLabel(
  g: LabelGeometry,
  design: LabelDesign,
  content: LabelContent,
  words: LabelWords,
  m: Measurer,
): LayoutResult {
  const d = (mm: number) => toDots(mm, g.dpi);
  const widthDots = d(g.widthMm);
  const heightDots = d(g.heightMm);
  const inset = design.border ? d(BORDER_INSET_MM) : 0;
  const printable = Math.min(widthDots, d(g.printableWidthMm));
  const contentW = printable - 2 * (d(design.marginsMm.side) + inset);
  const contentX = Math.floor((widthDots - contentW) / 2);
  const top = d(design.marginsMm.edge) + inset;
  const available = heightDots - 2 * top;
  if (contentW <= 0 || available <= 0) return { ok: false, reason: 'too_small' };

  const barcode = barcodeFor(content.barcodeData, {
    code128: design.barcode.symbology === 'code128',
  });
  if (!barcode) return { ok: false, reason: 'cannot_encode' };
  // The bars keep to the content area; their blank quiet zones may use the side margin, but stay
  // clear of the label's edge (or inside the border, which would read as a bar next to them).
  const quietLo = design.border ? contentX : d(QUIET_EDGE_MM);
  const quietHi = design.border ? contentX + contentW : widthDots - d(QUIET_EDGE_MM);
  const dots = moduleDots(barcode, quietHi - quietLo, g.dpi, contentW);
  if (dots === null) return { ok: false, reason: 'barcode_too_long' };
  const barsW = barcode.modules * dots;
  const quietL = barcode.quiet.left * dots;
  const quietR = barcode.quiet.right * dots;
  const barsLo = Math.max(contentX, quietLo + quietL);
  const barsHi = Math.min(contentX + contentW, quietHi - quietR) - barsW;
  if (barsLo > barsHi) return { ok: false, reason: 'barcode_too_long' };

  const minFont = d(MIN_TEXT_MM);
  const minBars = d(LABEL_BARCODE_MIN_HEIGHT_MM);
  const gap = d(GAP_MM);
  const tight = d(TIGHT_MM);
  const style = design.elements;
  // The barcode is always on a barcode label (decision 0097), whatever the design says.
  const shown = design.order.filter((e) => e === 'barcode' || style[e].show);

  /** The blocks with the bars `barsCut` dots shorter and the letters `shrink` dots smaller. */
  const plan = (barsCut: number, shrink: number): { blocks: Block[]; height: number } => {
    const blocks: Block[] = [];
    for (const element of shown) {
      const s = style[element];
      if (element === 'barcode') {
        const digitsFont = Math.max(minFont, d(TEXT_MM[s.size]) - shrink);
        blocks.push({
          kind: 'bars',
          h: Math.max(minBars, d(design.barcode.heightMm) - barsCut),
          digitsFont,
          digitsH: design.barcode.showDigits ? tight + lineHeight(m, digitsFont, 'latin') : 0,
          align: s.align,
        });
        continue;
      }
      if (element === 'price') {
        if (!content.price) continue;
        const fontDots = Math.max(minFont, d(PRICE_MM[s.size]) - shrink);
        const language = elementLanguage(design, 'price');
        const lines = languagesOf(language).map((l) => ({
          currency: words.currency[l],
          dir: l === 'ar' ? ('rtl' as const) : ('ltr' as const),
        }));
        const lineH = lineHeight(m, fontDots, language === 'en' ? 'latin' : 'arabic');
        blocks.push({ kind: 'price', lines, fontDots, lineH, bold: s.bold, align: s.align });
        continue;
      }
      const texts = textsOf(element, content, design, words);
      if (texts.length === 0) continue;
      const designed = d(TEXT_MM[s.size]);
      // The Arabic name: 2 lines; 1 once every letter is already as small as it can be. Every
      // other text: one line per language.
      const maxLines = element === 'nameAr' && shrink <= designed - minFont ? 2 : 1;
      // The largest letters (from the design's size down) at which every language fits without
      // "…"; at the smallest, "…" ends the line.
      const wrapAll = (font: number) =>
        texts.map((text) => wrapLines(m, text, contentW, font, s.bold, maxLines));
      let fontDots = Math.max(minFont, designed - shrink);
      let wrapped = wrapAll(fontDots);
      while (wrapped.some((w) => w.cut) && fontDots > minFont) {
        fontDots -= 1;
        wrapped = wrapAll(fontDots);
      }
      blocks.push({
        kind: 'text',
        part: element,
        lines: wrapped.flatMap((w) => w.lines),
        fontDots,
        lineH: Math.max(...texts.map((text) => lineHeight(m, fontDots, scriptOf(text)))),
        bold: s.bold,
        align: s.align,
      });
    }
    const heights = blocks.map((b) =>
      b.kind === 'bars' ? b.h + b.digitsH : b.lines.length * b.lineH,
    );
    const height = heights.reduce((a, b) => a + b, 0) + gap * Math.max(0, blocks.length - 1);
    return { blocks, height };
  };

  // Shrink until it fits: first the bars (down to their minimum), then the letters.
  const barsRoom = Math.max(0, d(design.barcode.heightMm) - minBars);
  const maxShrink = d(PRICE_MM.l) - minFont + 1;
  let chosen: { blocks: Block[]; height: number } | null = null;
  let fitted = false;
  for (let shrink = 0; shrink <= maxShrink && !chosen; shrink += 1) {
    const full = plan(0, shrink);
    if (shrink === 0 && full.height <= available) {
      chosen = full;
      break;
    }
    const short = plan(barsRoom, shrink);
    if (short.height <= available) {
      // The bars as tall as the design wants, as far as the space left allows.
      chosen = plan(Math.max(0, barsRoom - (available - short.height)), shrink);
      fitted = true;
    }
  }
  if (!chosen || chosen.height > available) return { ok: false, reason: 'too_small' };

  // Place the blocks, top to bottom, centred in the height that is left over.
  const right = contentX + contentW;
  const anchor = (align: LabelAlign, width: number) =>
    align === 'left'
      ? contentX
      : align === 'right'
        ? right - width
        : Math.round(contentX + (contentW - width) / 2);
  const drawAt = (align: LabelAlign, x: number, width: number) =>
    align === 'left' ? x : align === 'right' ? x + width : x + width / 2;
  const texts: TextLine[] = [];
  const prices: PriceLine[] = [];
  let bars: LabelLayout['bars'] | null = null;
  let y = top + Math.floor((available - chosen.height) / 2);
  chosen.blocks.forEach((block, i) => {
    if (i > 0) y += gap;
    if (block.kind === 'text') {
      for (const text of block.lines) {
        const width = Math.min(contentW, Math.ceil(m.width(text, block.fontDots, block.bold)));
        const x = anchor(block.align, width);
        texts.push({
          part: block.part,
          text,
          x: drawAt(block.align, x, width),
          baseline: baselineIn(m, y, block.lineH, block.fontDots, scriptOf(text)),
          fontDots: block.fontDots,
          bold: block.bold,
          dir: dirOf(text),
          align: block.align,
          box: { x, y, w: width, h: block.lineH },
        });
        y += block.lineH;
      }
    } else if (block.kind === 'bars') {
      const x = Math.min(barsHi, Math.max(barsLo, anchor(block.align, barsW)));
      bars = {
        rects: barRects(barcode, dots, x - quietL),
        y,
        h: block.h,
        moduleDots: dots,
        box: { x, y, w: barsW, h: block.h },
        quiet: { x: x - quietL, w: quietL + barsW + quietR },
      };
      y += block.h;
      if (block.digitsH > 0) {
        y += tight;
        const lineH = block.digitsH - tight;
        const width = Math.min(contentW, Math.ceil(m.width(barcode.data, block.digitsFont, false)));
        // The digits sit under the bars, centred on them, inside the content area.
        const x0 = Math.min(right - width, Math.max(contentX, Math.round(x + (barsW - width) / 2)));
        texts.push({
          part: 'digits',
          text: barcode.data,
          x: x0 + width / 2,
          baseline: baselineIn(m, y, lineH, block.digitsFont, 'latin'),
          fontDots: block.digitsFont,
          bold: false,
          dir: 'ltr',
          align: 'center',
          box: { x: x0, y, w: width, h: lineH },
        });
        y += lineH;
      }
    } else {
      const amount = content.price!.amount;
      for (const line of block.lines) {
        const wAmount = m.width(amount, block.fontDots, block.bold);
        const wCurrency = m.width(line.currency, block.fontDots, block.bold);
        const wSpace = m.width(' ', block.fontDots, block.bold);
        const width = Math.min(contentW, Math.ceil(wAmount + wSpace + wCurrency));
        const x = anchor(block.align, width);
        // Seen from the left: the currency, then the number. Arabic reads "120.00 درهم" from the
        // right; English reads "AED 120.00".
        prices.push({
          runs: [
            { text: line.currency, x, dir: line.dir },
            { text: amount, x: Math.round(x + wCurrency + wSpace), dir: 'ltr' },
          ],
          baseline: baselineIn(
            m,
            y,
            block.lineH,
            block.fontDots,
            line.dir === 'rtl' ? 'arabic' : 'latin',
          ),
          fontDots: block.fontDots,
          bold: block.bold,
          box: { x, y, w: width, h: block.lineH },
        });
        y += block.lineH;
      }
    }
  });

  const border = design.border
    ? { x: contentX - inset, y: top - inset, w: contentW + 2 * inset, h: available + 2 * inset }
    : null;
  return {
    ok: true,
    widthDots,
    heightDots,
    content: { x: contentX, y: top, w: contentW, h: available },
    texts,
    bars: bars!,
    prices,
    border,
    fitted,
  };
}

/** Every box on the label, for checks (nothing overlaps, everything inside the content area). */
export function layoutBoxes(layout: LabelLayout): { part: string; box: Box }[] {
  return [
    ...layout.texts.map((line, i) => ({ part: `${line.part}#${i}`, box: line.box })),
    { part: 'bars', box: layout.bars.box },
    ...layout.prices.map((line, i) => ({ part: `price#${i}`, box: line.box })),
  ];
}
