/**
 * ESC/POS for 80 mm thermal printers (decision 0055: Epson TM-T20III / TM-T82 and compatibles).
 * The receipt is drawn as an image in the app, so Arabic always prints correctly; here it becomes
 * raster commands (GS v 0), a feed and a cut. The cash drawer is wired to the printer (RJ11) and
 * opens with the drawer-kick pulse, sent first so it opens while the receipt prints.
 */

/** Printable width of an 80 mm head at 203 dpi. */
export const PAPER_DOTS = 576;

const ESC = 0x1b;
const GS = 0x1d;

/** ESC @: reset the printer to its defaults. */
export const INIT = [ESC, 0x40] as const;
/** ESC p 0 t1 t2: pulse on drawer pin 2 (50 ms on, 500 ms off), the usual RJ11 wiring. */
export const DRAWER_KICK = [ESC, 0x70, 0x00, 0x19, 0xfa] as const;
/** GS V 66 n: feed n dots then a partial cut, so the receipt clears the cutter. */
export const FEED_AND_CUT = [GS, 0x56, 0x42, 0x60] as const;

/** Most compatible printers take at most this many rows per raster command. */
const ROWS_PER_BLOCK = 256;

/**
 * Packs an RGBA image into 1-bit rows (MSB first, 1 = black). A pixel prints when it is darker
 * than the threshold after blending with white paper; the width is padded to whole bytes.
 */
export function toMonochrome(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 160,
): { bits: Uint8Array; widthBytes: number } {
  const widthBytes = Math.ceil(width / 8);
  const bits = new Uint8Array(widthBytes * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const alpha = rgba[i + 3]! / 255;
      // Luminance on white paper (transparent = paper).
      const lum =
        (0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!) * alpha +
        255 * (1 - alpha);
      if (lum < threshold) bits[y * widthBytes + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { bits, widthBytes };
}

/** GS v 0: one raster block, normal density. */
function rasterBlock(
  bits: Uint8Array,
  widthBytes: number,
  fromRow: number,
  rows: number,
): number[] {
  const out = [GS, 0x76, 0x30, 0x00, widthBytes & 0xff, widthBytes >> 8, rows & 0xff, rows >> 8];
  const start = fromRow * widthBytes;
  for (let i = start; i < start + rows * widthBytes; i += 1) out.push(bits[i]!);
  return out;
}

/** A whole receipt job: reset, optional drawer kick, the image in blocks, feed and cut. */
export function receiptJob(image: {
  bits: Uint8Array;
  widthBytes: number;
  height: number;
  kickDrawer: boolean;
}): Uint8Array {
  const out: number[] = [...INIT];
  if (image.kickDrawer) out.push(...DRAWER_KICK);
  for (let row = 0; row < image.height; row += ROWS_PER_BLOCK) {
    out.push(
      ...rasterBlock(
        image.bits,
        image.widthBytes,
        row,
        Math.min(ROWS_PER_BLOCK, image.height - row),
      ),
    );
  }
  out.push(...FEED_AND_CUT);
  return Uint8Array.from(out);
}

/** Opens the drawer only (No Sale, cash movements, a cash refund without a receipt). */
export function drawerKickJob(): Uint8Array {
  return Uint8Array.from([...INIT, ...DRAWER_KICK]);
}

export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}
