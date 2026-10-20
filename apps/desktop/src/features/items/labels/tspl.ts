/**
 * Direct printing to the label printer in its own language, TSPL (decision 0100): the label drawn
 * by the app (1 bit per printer dot, decisions 0096, 0097) is sent as one BITMAP with the label's
 * size, the gap between labels, the direction, darkness and speed, and the number of copies. No
 * Windows driver in between, so nothing is scaled or smoothed. The bytes go RAW to the printer.
 */
import type { LabelPrinterConfig, LabelSizeItem } from '@artepool/shared/contracts';
import type { LabelImage } from './render';

const ascii = (text: string) => new TextEncoder().encode(text);

/** "50", "30", "2.5": millimetres the way TSPL takes them (at most one decimal). */
const mm = (value: number) => String(Math.round(value * 10) / 10);

/**
 * Where the label sits under the print head (the roll runs in the middle of the head): a label
 * wider than the head is cut to the head's width, centred; a narrower one starts that far in from
 * the head's first dot. The offset found with the test label still moves it, as in the drawing.
 */
export function placeOnHead(widthDots: number, printableDots: number) {
  const width = Math.min(widthDots, printableDots);
  return {
    /** The first column of the drawing that is sent. */
    first: Math.floor((widthDots - width) / 2),
    width,
    /** Where it starts on the head (TSPL x). */
    x: Math.floor((printableDots - width) / 2),
  };
}

/**
 * The TSPL job for `copies` labels of one drawn label. In TSPL's BITMAP a 0 bit prints a black dot
 * and a 1 bit leaves it white, the opposite of the app's drawing: the bits are turned round.
 */
export function tsplLabelJob(
  image: Pick<LabelImage, 'bits' | 'widthBytes' | 'widthDots' | 'height'>,
  size: Pick<LabelSizeItem, 'widthMm' | 'heightMm'>,
  config: Pick<
    LabelPrinterConfig,
    'dpi' | 'printableWidthMm' | 'darkness' | 'speed' | 'gapMm' | 'flip'
  >,
  copies: number,
): Uint8Array {
  if (!Number.isInteger(copies) || copies < 1) throw new Error('copies must be 1 or more');
  // Rounded as the layout rounds it (layout.ts), so the drawing and the job agree to the dot.
  const printableDots = Math.round((config.printableWidthMm * config.dpi) / 25.4);
  const { first, width, x: headX } = placeOnHead(image.widthDots, printableDots);
  const outBytes = Math.ceil(width / 8);
  const data = new Uint8Array(outBytes * image.height).fill(0xff);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = first + x;
      const black = (image.bits[y * image.widthBytes + (sx >> 3)]! >> (7 - (sx & 7))) & 1;
      if (black) data[y * outBytes + (x >> 3)]! &= ~(0x80 >> (x & 7));
    }
  }
  const header = ascii(
    [
      `SIZE ${mm(size.widthMm)} mm,${mm(size.heightMm)} mm`,
      `GAP ${mm(config.gapMm)} mm,0 mm`,
      `DIRECTION ${config.flip ? 0 : 1},0`,
      'REFERENCE 0,0',
      `DENSITY ${config.darkness}`,
      `SPEED ${config.speed}`,
      'CLS',
      `BITMAP ${headX},0,${outBytes},${image.height},0,`,
    ].join('\r\n'),
  );
  const footer = ascii(`\r\nPRINT 1,${copies}\r\n`);
  const job = new Uint8Array(header.length + data.length + footer.length);
  job.set(header, 0);
  job.set(data, header.length);
  job.set(footer, header.length + data.length);
  return job;
}
