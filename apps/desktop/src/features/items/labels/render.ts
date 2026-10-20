/**
 * Draws a barcode label (decision 0096) on a canvas of the label's exact size in printer dots, black
 * on white, then packs it to 1 bit per dot for the printer. The browser shapes the Arabic; bars are
 * whole-dot rectangles, never smoothed. The same image is the preview on the screen and what the
 * printer receives. The printer's X/Y offset (calibration) moves everything on the label.
 */
import { toMonochrome } from '../../pos/receipt/escpos';
import { receiptFontFamily } from '../../pos/receipt/render';
import { barcodeFor, barRects, fullModules, moduleDots } from './barcode';
import type { LabelGeometry, LabelLayout, Measurer } from './layout';

export interface LabelImage {
  canvas: HTMLCanvasElement;
  /** 1 bit per dot, rows of `widthBytes`, top row first; 1 = black. */
  bits: Uint8Array;
  widthBytes: number;
  widthDots: number;
  height: number;
}

/**
 * Reference letters for how high and low each script reaches: separate (not joined) Arabic letters,
 * so the deep final forms (ج ع ي ق ن) and the marks above and below (أ إ ُ) all count.
 */
const REFERENCE = { arabic: 'آ أ إ ج ع ي ق ن ك لأ هُ ؤ', latin: 'ÁÉgjpqy0123' } as const;

const font = (dots: number, bold: boolean, family: string) =>
  `${bold ? '700' : '400'} ${dots}px ${family}`;

/** Without a canvas (only in some test browsers): about as wide and high as the app's fonts. */
const estimate: Measurer = {
  width: (text, fontDots) => text.length * fontDots * 0.55,
  extent: (fontDots) => ({ ascent: fontDots * 0.9, descent: fontDots * 0.45 }),
};

/** Text measured with the canvas, in the app's own font. */
export function canvasMeasurer(family = receiptFontFamily()): Measurer {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return estimate;
  const extents = new Map<string, { ascent: number; descent: number }>();
  return {
    width(text, fontDots, bold) {
      ctx.font = font(fontDots, bold, family);
      return ctx.measureText(text).width;
    },
    extent(fontDots, script) {
      const key = `${fontDots}:${script}`;
      let found = extents.get(key);
      if (!found) {
        ctx.font = font(fontDots, true, family);
        const metrics = ctx.measureText(REFERENCE[script]);
        found = {
          ascent: Math.max(metrics.actualBoundingBoxAscent, fontDots * 0.7),
          descent: Math.max(metrics.actualBoundingBoxDescent, fontDots * 0.2),
        };
        extents.set(key, found);
      }
      return found;
    },
  };
}

/**
 * Where black starts when the drawn label is cut to black and white (0–255 lightness). Higher than
 * the receipt's 160: thin strokes of small letters stay whole on a 203 dpi thermal head. Never
 * dithered: a dot is black or white.
 */
export const LABEL_THRESHOLD = 175;

const ARABIC_TEXT = /[\u0600-\u06FF]/;

/**
 * Draws one run of text. Arabic gets a thin outline of its own colour as well: GE SS TV has one
 * weight, and its joins are thin at 203 dpi; the outline makes them about half a dot bolder.
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  style: { fontDots: number; bold: boolean; dir: 'rtl' | 'ltr'; align: CanvasTextAlign },
  family: string,
) {
  ctx.font = font(style.fontDots, style.bold, family);
  ctx.direction = style.dir;
  ctx.textAlign = style.align;
  ctx.fillText(text, x, y);
  if (ARABIC_TEXT.test(text)) {
    ctx.lineWidth = Math.max(0.6, style.fontDots * 0.04);
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
  }
}

/** A white canvas of the label's size, with the offset applied; `draw` adds the content. */
function paint(
  widthDots: number,
  heightDots: number,
  offset: { x: number; y: number },
  draw: (ctx: CanvasRenderingContext2D) => void,
): LabelImage {
  const canvas = document.createElement('canvas');
  canvas.width = widthDots;
  canvas.height = heightDots;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas to draw the label on');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, widthDots, heightDots);
  ctx.save();
  ctx.translate(Math.round(offset.x), Math.round(offset.y));
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  draw(ctx);
  ctx.restore();
  const { data } = ctx.getImageData(0, 0, widthDots, heightDots);
  const { bits, widthBytes } = toMonochrome(data, widthDots, heightDots, LABEL_THRESHOLD);
  return { canvas, bits, widthBytes, widthDots, height: heightDots };
}

/** Draws a laid-out label. `offset` (dots) is the printer's calibration. */
export function renderLabel(
  layout: LabelLayout,
  offset = { x: 0, y: 0 },
  family = receiptFontFamily(),
): LabelImage {
  return paint(layout.widthDots, layout.heightDots, offset, (ctx) => {
    for (const line of layout.texts) {
      drawText(ctx, line.text, line.x, line.baseline, line, family);
    }
    for (const bar of layout.bars.rects) ctx.fillRect(bar.x, layout.bars.y, bar.w, layout.bars.h);
    for (const price of layout.prices) {
      for (const run of price.runs) {
        drawText(
          ctx,
          run.text,
          run.x,
          price.baseline,
          { fontDots: price.fontDots, bold: price.bold, dir: run.dir, align: 'left' },
          family,
        );
      }
    }
    if (layout.border) {
      const b = layout.border;
      const thick = Math.max(2, Math.round(layout.widthDots / 200));
      ctx.lineWidth = thick;
      ctx.strokeRect(b.x + thick / 2, b.y + thick / 2, b.w - thick, b.h - thick);
    }
  });
}

/**
 * The calibration label (Settings → Devices): a border on the label's edge, a cross at its centre,
 * a 5 mm ruler along the top and the side, the printable width marked, the settings in words and a
 * test barcode. Printed with the offset, it shows which way to move the print.
 */
export function renderTestLabel(
  g: LabelGeometry,
  offsetMm: { x: number; y: number },
  caption: string,
  family = receiptFontFamily(),
): LabelImage {
  const d = (mm: number) => Math.round((mm * g.dpi) / 25.4);
  const w = d(g.widthMm);
  const h = d(g.heightMm);
  return paint(w, h, { x: d(offsetMm.x), y: d(offsetMm.y) }, (ctx) => {
    const thick = Math.max(2, d(0.25));
    ctx.lineWidth = thick;
    ctx.strokeRect(thick / 2, thick / 2, w - thick, h - thick);
    // Centre cross.
    const arm = d(4);
    ctx.fillRect(Math.round(w / 2 - thick / 2), Math.round(h / 2 - arm), thick, arm * 2);
    ctx.fillRect(Math.round(w / 2 - arm), Math.round(h / 2 - thick / 2), arm * 2, thick);
    // Ruler: a tick every 5 mm, longer every 10 mm, from the left and the top edges.
    for (let mm = 5; mm < g.widthMm; mm += 5) {
      ctx.fillRect(d(mm), 0, Math.max(1, thick / 2), d(mm % 10 === 0 ? 2.5 : 1.5));
    }
    for (let mm = 5; mm < g.heightMm; mm += 5) {
      ctx.fillRect(0, d(mm), d(mm % 10 === 0 ? 2.5 : 1.5), Math.max(1, thick / 2));
    }
    // The printable width, as short marks at the bottom.
    const printable = Math.min(w, d(g.printableWidthMm));
    const left = Math.floor((w - printable) / 2);
    ctx.fillRect(left, h - d(3), thick, d(3));
    ctx.fillRect(left + printable - thick, h - d(3), thick, d(3));
    // The settings in words.
    ctx.font = font(d(1.9), false, family);
    ctx.textAlign = 'center';
    ctx.direction = 'ltr';
    ctx.fillText(caption, w / 2, d(5.5));
    // A test barcode, under the cross.
    const barcode = barcodeFor('TEST-1234')!;
    const dots = moduleDots(barcode, printable - d(2), g.dpi);
    if (dots !== null) {
      const x = Math.round(w / 2 - (fullModules(barcode) * dots) / 2);
      const y = Math.round(h / 2 + arm + d(1));
      const barsH = Math.max(0, Math.min(d(6), h - y - d(4)));
      for (const bar of barRects(barcode, dots, x)) ctx.fillRect(bar.x, y, bar.w, barsH);
    }
  });
}

/**
 * The print quality test (Settings → Devices, decision 0097): fine lines of 1, 2 and 3 dots across
 * and down, a solid block, Arabic and English text small and large, and the same barcode at 2 and 3
 * dots per module. On a good print every line is separate, the block is evenly black, the small
 * letters are whole and both barcodes scan.
 */
export function renderQualityLabel(
  g: LabelGeometry,
  offsetMm: { x: number; y: number },
  texts: { arabic: string; english: string },
  family = receiptFontFamily(),
): LabelImage {
  const d = (mm: number) => Math.round((mm * g.dpi) / 25.4);
  const w = d(g.widthMm);
  const h = d(g.heightMm);
  const printable = Math.min(w, d(g.printableWidthMm)) - d(2);
  const left = Math.floor((w - printable) / 2);
  return paint(w, h, { x: d(offsetMm.x), y: d(offsetMm.y) }, (ctx) => {
    let y = d(1);
    // Lines down (1, 2, 3 dots, each twice, a gap of their own width), then a solid block.
    const block = d(4);
    let x = left;
    for (const width of [1, 2, 3]) {
      for (let i = 0; i < 2; i += 1) {
        ctx.fillRect(x, y, width, block);
        x += width * 2;
      }
      x += d(1);
    }
    ctx.fillRect(left + printable - block * 2, y, block * 2, block);
    // Lines across, under them.
    y += block + d(0.6);
    for (const width of [1, 2, 3]) {
      ctx.fillRect(left, y, Math.round(printable * 0.45), width);
      y += width * 2 + 1;
    }
    // Text: small (1.8 mm) and large (3 mm), Arabic and English.
    const small = d(1.8);
    const large = d(3);
    y += large;
    drawText(
      ctx,
      texts.arabic,
      left + printable,
      y,
      { fontDots: large, bold: true, dir: 'rtl', align: 'right' },
      family,
    );
    drawText(
      ctx,
      texts.english,
      left,
      y,
      { fontDots: small, bold: false, dir: 'ltr', align: 'left' },
      family,
    );
    y += small + d(0.8);
    drawText(
      ctx,
      texts.arabic,
      left + printable,
      y,
      { fontDots: small, bold: false, dir: 'rtl', align: 'right' },
      family,
    );
    drawText(
      ctx,
      texts.english,
      left,
      y,
      { fontDots: large, bold: true, dir: 'ltr', align: 'left' },
      family,
    );
    y += d(1);
    // The same code at 2 and 3 dots per module, side by side when they fit, else one under the other.
    const barcode = barcodeFor('Q-1234')!;
    const barsH = Math.max(d(3), Math.min(d(5), h - y - d(1)));
    let bx = left;
    for (const dots of [2, 3]) {
      const width = fullModules(barcode) * dots;
      if (bx + width > left + printable) {
        bx = left;
        y += barsH + d(0.8);
      }
      if (y + barsH > h) break;
      for (const bar of barRects(barcode, dots, bx)) ctx.fillRect(bar.x, y, bar.w, barsH);
      bx += width + d(1);
    }
  });
}

/** The dots the printer will print (black or white, nothing in between), as an image to show. */
export function printedDotsUrl(image: LabelImage): string {
  const canvas = document.createElement('canvas');
  canvas.width = image.widthDots;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const pixels = ctx.createImageData(image.widthDots, image.height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.widthDots; x += 1) {
      const black = (image.bits[y * image.widthBytes + (x >> 3)]! & (0x80 >> (x & 7))) !== 0;
      const i = (y * image.widthDots + x) * 4;
      pixels.data.fill(black ? 0 : 255, i, i + 3);
      pixels.data[i + 3] = 255;
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}
