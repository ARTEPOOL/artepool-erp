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
  const { bits, widthBytes } = toMonochrome(data, widthDots, heightDots);
  return { canvas, bits, widthBytes, widthDots, height: heightDots };
}

/** Draws a laid-out label. `offset` (dots) is the printer's calibration. */
export function renderLabel(
  layout: LabelLayout,
  offset = { x: 0, y: 0 },
  family = receiptFontFamily(),
): LabelImage {
  return paint(layout.widthDots, layout.heightDots, offset, (ctx) => {
    const line = (l: {
      text: string;
      cx: number;
      baseline: number;
      fontDots: number;
      bold: boolean;
      dir: 'rtl' | 'ltr';
    }) => {
      ctx.font = font(l.fontDots, l.bold, family);
      ctx.direction = l.dir;
      ctx.textAlign = 'center';
      ctx.fillText(l.text, l.cx, l.baseline);
    };
    layout.name.forEach(line);
    if (layout.english) line(layout.english);
    for (const bar of layout.bars.rects) ctx.fillRect(bar.x, layout.bars.y, bar.w, layout.bars.h);
    line(layout.code);
    if (layout.price) {
      ctx.font = font(layout.price.fontDots, true, family);
      ctx.textAlign = 'left';
      for (const run of layout.price.runs) {
        ctx.direction = run.dir;
        ctx.fillText(run.text, run.x, run.baseline);
      }
    }
    if (layout.vat) line(layout.vat);
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
