/**
 * Draws the receipt model on a canvas the width of the paper (576 dots for 80 mm), in black on
 * white, then packs it to 1-bit rows for the printer. The browser shapes Arabic itself, so the
 * printer only ever receives an image. Sizes here are printer dots (the paper's geometry), not
 * screen spacing; the font is the app's own font token.
 */
import { PAPER_DOTS, toMonochrome } from './escpos';
import type { ReceiptModel } from './layout';

const MARGIN = 8;
const FONT_DOTS = { s: 22, m: 28, l: 36 } as const;
const LINE_GAP = 6;

export interface ReceiptImage {
  canvas: HTMLCanvasElement;
  bits: Uint8Array;
  widthBytes: number;
  height: number;
}

/** The app's font family (design token), with a fallback for the drawing. */
export function receiptFontFamily(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--font-family').trim();
  return value || 'sans-serif';
}

/** Splits text into lines that fit the width, at spaces (a single long word stays whole). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(next).width > width) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/** Lays out (draw = false: only measures) and returns the height used. */
function layout(
  ctx: CanvasRenderingContext2D,
  model: ReceiptModel,
  family: string,
  width: number,
  draw: boolean,
): number {
  const rtl = model.dir === 'rtl';
  const startX = rtl ? width - MARGIN : MARGIN;
  const endX = rtl ? MARGIN : width - MARGIN;
  const usable = width - 2 * MARGIN;
  let y = MARGIN;
  ctx.direction = model.dir;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  const font = (line: { size?: 's' | 'm' | 'l'; bold?: boolean }) => {
    const size = FONT_DOTS[line.size ?? 's'];
    ctx.font = `${line.bold ? '700' : '400'} ${size}px ${family}`;
    return size;
  };
  for (const line of model.lines) {
    if (line.kind === 'space') {
      y += FONT_DOTS.s / 2;
    } else if (line.kind === 'rule') {
      const thick = line.heavy ? 3 : 1;
      if (draw) {
        ctx.setLineDash(line.heavy ? [] : [6, 4]);
        ctx.lineWidth = thick;
        ctx.beginPath();
        ctx.moveTo(MARGIN, y + 6);
        ctx.lineTo(width - MARGIN, y + 6);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      y += 12 + thick;
    } else if (line.kind === 'text') {
      const size = font(line);
      for (const part of wrap(ctx, line.text, usable)) {
        if (draw) {
          ctx.textAlign = line.align === 'center' ? 'center' : 'start';
          ctx.fillText(part, line.align === 'center' ? width / 2 : startX, y);
        }
        y += size + LINE_GAP;
      }
    } else {
      const size = font(line);
      const valueWidth = ctx.measureText(line.value).width;
      const labelLines = wrap(ctx, line.label, Math.max(usable - valueWidth - 16, usable / 3));
      if (draw) {
        ctx.textAlign = 'end';
        ctx.fillText(line.value, endX, y);
        ctx.textAlign = 'start';
        labelLines.forEach((part, i) => ctx.fillText(part, startX, y + i * (size + LINE_GAP)));
      }
      y += labelLines.length * (size + LINE_GAP);
    }
  }
  return Math.ceil(y + MARGIN);
}

/** Printer dots across the paper: 80 mm paper prints 576 dots, 58 mm paper 384. */
export const paperDots = (mm: 80 | 58 = 80): number => (mm === 58 ? 384 : PAPER_DOTS);

/** The logo's height on the receipt, in dots. */
const LOGO_DOTS = 120;

export function renderReceipt(
  model: ReceiptModel,
  family = receiptFontFamily(),
  logo: (CanvasImageSource & { width: number; height: number }) | null = null,
): ReceiptImage {
  const width = paperDots(model.paperWidthMm);
  const drawLogo = model.logo && logo && logo.width > 0 && logo.height > 0 ? logo : null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = 10;
  const measure = canvas.getContext('2d');
  if (!measure) throw new Error('Canvas is not available');
  const top = drawLogo ? LOGO_DOTS + MARGIN : 0;
  const height = layout(measure, model, family, width, false) + top;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  if (drawLogo) {
    // Centred, scaled to fit; the printer prints it in black and white.
    const scale = Math.min(LOGO_DOTS / drawLogo.height, (width - 2 * MARGIN) / drawLogo.width);
    const w = drawLogo.width * scale;
    const h = drawLogo.height * scale;
    ctx.drawImage(drawLogo, (width - w) / 2, MARGIN, w, h);
  }
  ctx.translate(0, top);
  layout(ctx, model, family, width, true);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const { bits, widthBytes } = toMonochrome(
    ctx.getImageData(0, 0, width, height).data,
    width,
    height,
  );
  return { canvas, bits, widthBytes, height };
}
