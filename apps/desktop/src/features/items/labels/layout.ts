/**
 * The barcode label layout (decision 0096): fixed zones in millimetres, worked out in the printer's
 * own dots, top to bottom: the Arabic name (at most 2 lines, letters shrink to a readable minimum,
 * then "…"), the English name when asked for and there is room (1 line), the bars (whole dots per
 * module, quiet zones blank), the code under the bars, the price ("120.00 درهم" / "AED 120.00",
 * the number always its own left-to-right run) and "incl. VAT". Everything stays inside the
 * printer's printable width, centred on the label; nothing ever overlaps. A label too small for
 * all of it is refused, never squeezed. Pure: text is measured by the caller (a canvas, or a test).
 */
import { barRects, fullModules, moduleDots, type Barcode } from './barcode';

export interface LabelGeometry {
  widthMm: number;
  heightMm: number;
  /** Printer dots per inch (203 or 300). */
  dpi: number;
  /** How wide the printer prints (48 mm on a 2-inch printer); the content never goes beyond it. */
  printableWidthMm: number;
}

export interface LabelText {
  /** The Arabic name, always printed. */
  nameAr: string;
  /** The English name: printed only when given here and there is room. */
  nameEn?: string | null;
  barcode: Barcode;
  /** The price, in the label's language; null = no price. */
  price?: {
    language: 'ar' | 'en';
    /** "120.00" (Western digits, always left to right). */
    amount: string;
    /** "درهم" or "AED". */
    currency: string;
    /** "شامل الضريبة" / "incl. VAT" when the price includes VAT, else null. */
    vatNote?: string | null;
  } | null;
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

export interface TextLine {
  text: string;
  /** Centre of the line (x) and its baseline (y), in dots. */
  cx: number;
  baseline: number;
  fontDots: number;
  bold: boolean;
  dir: 'rtl' | 'ltr';
  /** The line's box: its full height and the measured width. */
  box: Box;
}

export interface PriceRun {
  text: string;
  /** Left edge of the run (x) and its baseline (y), in dots. */
  x: number;
  baseline: number;
  dir: 'rtl' | 'ltr';
}

export interface LabelLayout {
  ok: true;
  widthDots: number;
  heightDots: number;
  /** Where content may go: the printable width minus a small margin, centred on the label. */
  content: Box;
  name: TextLine[];
  english: TextLine | null;
  bars: { rects: { x: number; w: number }[]; y: number; h: number; moduleDots: number; box: Box };
  code: TextLine;
  price: { runs: PriceRun[]; fontDots: number; box: Box } | null;
  vat: TextLine | null;
}

export type LayoutResult = LabelLayout | { ok: false; reason: 'too_small' | 'barcode_too_long' };

/** The sizes (mm) the layout works with. */
export const LABEL_MM = {
  /** Blank margin inside the printable width (each side) and at the top and bottom. */
  side: 1,
  edge: 1,
  name: { max: 3.4, min: 2.2 },
  english: { max: 2.4, min: 1.9 },
  code: 1.9,
  price: 2.8,
  vat: 1.8,
  bars: { min: 5, max: 14 },
  /** Gaps between zones. */
  gap: 0.6,
  tightGap: 0.3,
} as const;

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

const toDots = (mm: number, dpi: number) => Math.round((mm * dpi) / 25.4);

export function layoutLabel(g: LabelGeometry, t: LabelText, m: Measurer): LayoutResult {
  const d = (mm: number) => toDots(mm, g.dpi);
  const widthDots = d(g.widthMm);
  const heightDots = d(g.heightMm);
  const printable = Math.min(widthDots, d(g.printableWidthMm));
  const contentW = printable - 2 * d(LABEL_MM.side);
  const contentX = Math.floor((widthDots - contentW) / 2);
  const top = d(LABEL_MM.edge);
  const available = heightDots - 2 * top;
  const cx = contentX + contentW / 2;

  // The bars: whole dots per module, centred.
  const dots = moduleDots(t.barcode, contentW, g.dpi);
  if (dots === null) return { ok: false, reason: 'barcode_too_long' };

  // Fixed parts under the bars.
  const codeFont = d(LABEL_MM.code);
  const codeH = lineHeight(m, codeFont, 'latin');
  const priceFont = d(LABEL_MM.price);
  const priceH = t.price
    ? lineHeight(m, priceFont, t.price.language === 'ar' ? 'arabic' : 'latin')
    : 0;
  const vatFont = d(LABEL_MM.vat);
  const vatScript = t.price?.language === 'ar' ? 'arabic' : 'latin';
  const vatH = t.price?.vatNote ? lineHeight(m, vatFont, vatScript) : 0;
  const gap = d(LABEL_MM.gap);
  const tight = d(LABEL_MM.tightGap);
  const below = tight + codeH + (t.price ? gap + priceH : 0) + (vatH ? tight + vatH : 0);
  const barsMin = d(LABEL_MM.bars.min);
  const nameBudget = available - below - gap - barsMin;

  // The Arabic name: the largest font (max → min) that fits in 2 lines within its budget.
  const nameFonts = { max: d(LABEL_MM.name.max), min: d(LABEL_MM.name.min) };
  let name: { lines: string[]; font: number; lineH: number } | null = null;
  for (let font = nameFonts.max; font >= nameFonts.min; font -= 1) {
    const wrapped = wrapLines(m, t.nameAr, contentW, font, true, 2);
    const lineH = lineHeight(m, font, 'arabic');
    if (!wrapped.cut && wrapped.lines.length * lineH <= nameBudget) {
      name = { lines: wrapped.lines, font, lineH };
      break;
    }
  }
  if (!name) {
    // Even the smallest letters need "…": as many lines as fit (2 at most, 1 at least).
    const font = nameFonts.min;
    const lineH = lineHeight(m, font, 'arabic');
    const max = Math.min(2, Math.floor(nameBudget / lineH));
    if (max < 1) return { ok: false, reason: 'too_small' };
    name = { lines: wrapLines(m, t.nameAr, contentW, font, true, max).lines, font, lineH };
  }
  const nameH = name.lines.length * name.lineH;

  // The English name: one line, only when the bars keep their minimum height.
  let english: { text: string; font: number; lineH: number } | null = null;
  const nameEn = t.nameEn?.trim();
  if (nameEn) {
    const left = available - below - gap - nameH - barsMin - tight;
    for (let font = d(LABEL_MM.english.max); font >= d(LABEL_MM.english.min); font -= 1) {
      const lineH = lineHeight(m, font, 'latin');
      if (lineH > left) continue;
      const wrapped = wrapLines(m, nameEn, contentW, font, false, 1);
      if (!wrapped.cut || font === d(LABEL_MM.english.min)) {
        english = { text: wrapped.lines[0] ?? '', font, lineH };
        break;
      }
    }
  }
  const englishH = english ? tight + english.lineH : 0;

  // The bars take what is left (up to their maximum); any space left over centres the label.
  const barsH = Math.min(d(LABEL_MM.bars.max), available - below - gap - nameH - englishH);
  if (barsH < barsMin) return { ok: false, reason: 'too_small' };
  const used = nameH + englishH + gap + barsH + below;
  let y = top + Math.floor((available - used) / 2);

  const nameLines: TextLine[] = name.lines.map((text) => {
    const width = Math.min(contentW, Math.ceil(m.width(text, name.font, true)));
    const line: TextLine = {
      text,
      cx,
      baseline: baselineIn(m, y, name.lineH, name.font, 'arabic'),
      fontDots: name.font,
      bold: true,
      dir: 'rtl',
      box: { x: Math.round(cx - width / 2), y, w: width, h: name.lineH },
    };
    y += name.lineH;
    return line;
  });

  let englishLine: TextLine | null = null;
  if (english) {
    y += tight;
    const width = Math.min(contentW, Math.ceil(m.width(english.text, english.font, false)));
    englishLine = {
      text: english.text,
      cx,
      baseline: baselineIn(m, y, english.lineH, english.font, 'latin'),
      fontDots: english.font,
      bold: false,
      dir: 'ltr',
      box: { x: Math.round(cx - width / 2), y, w: width, h: english.lineH },
    };
    y += english.lineH;
  }

  y += gap;
  const symbolW = fullModules(t.barcode) * dots;
  const barsX = Math.round(cx - symbolW / 2);
  const bars = {
    rects: barRects(t.barcode, dots, barsX),
    y,
    h: barsH,
    moduleDots: dots,
    box: { x: barsX, y, w: symbolW, h: barsH },
  };
  y += barsH + tight;

  const codeW = Math.min(contentW, Math.ceil(m.width(t.barcode.data, codeFont, false)));
  const code: TextLine = {
    text: t.barcode.data,
    cx,
    baseline: baselineIn(m, y, codeH, codeFont, 'latin'),
    fontDots: codeFont,
    bold: false,
    dir: 'ltr',
    box: { x: Math.round(cx - codeW / 2), y, w: codeW, h: codeH },
  };
  y += codeH;

  let price: LabelLayout['price'] = null;
  let vat: TextLine | null = null;
  if (t.price) {
    y += gap;
    const p = t.price;
    const script = p.language === 'ar' ? 'arabic' : 'latin';
    const wAmount = m.width(p.amount, priceFont, true);
    const wCurrency = m.width(p.currency, priceFont, true);
    const wSpace = m.width(' ', priceFont, true);
    const total = Math.ceil(wAmount + wSpace + wCurrency);
    const left = Math.round(cx - total / 2);
    const baseline = baselineIn(m, y, priceH, priceFont, script);
    // Arabic reads right to left: the number on the right, "درهم" to its left. English: "AED 120.00".
    const runs: PriceRun[] =
      p.language === 'ar'
        ? [
            { text: p.currency, x: left, baseline, dir: 'rtl' },
            { text: p.amount, x: Math.round(left + wCurrency + wSpace), baseline, dir: 'ltr' },
          ]
        : [
            { text: p.currency, x: left, baseline, dir: 'ltr' },
            { text: p.amount, x: Math.round(left + wCurrency + wSpace), baseline, dir: 'ltr' },
          ];
    price = { runs, fontDots: priceFont, box: { x: left, y, w: total, h: priceH } };
    y += priceH;
    if (p.vatNote) {
      y += tight;
      const width = Math.min(contentW, Math.ceil(m.width(p.vatNote, vatFont, false)));
      vat = {
        text: p.vatNote,
        cx,
        baseline: baselineIn(m, y, vatH, vatFont, vatScript),
        fontDots: vatFont,
        bold: false,
        dir: p.language === 'ar' ? 'rtl' : 'ltr',
        box: { x: Math.round(cx - width / 2), y, w: width, h: vatH },
      };
      y += vatH;
    }
  }

  return {
    ok: true,
    widthDots,
    heightDots,
    content: { x: contentX, y: top, w: contentW, h: available },
    name: nameLines,
    english: englishLine,
    bars,
    code,
    price,
    vat,
  };
}

/** Every box on the label, for checks (nothing overlaps, everything inside the content area). */
export function layoutBoxes(layout: LabelLayout): { part: string; box: Box }[] {
  return [
    ...layout.name.map((line, i) => ({ part: `name${i + 1}`, box: line.box })),
    ...(layout.english ? [{ part: 'english', box: layout.english.box }] : []),
    { part: 'bars', box: layout.bars.box },
    { part: 'code', box: layout.code.box },
    ...(layout.price ? [{ part: 'price', box: layout.price.box }] : []),
    ...(layout.vat ? [{ part: 'vat', box: layout.vat.box }] : []),
  ];
}
