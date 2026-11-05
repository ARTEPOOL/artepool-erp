/**
 * Is there text on this PDF? (M7 rehearsal.) The A4 renderer once gave blank pages when its fonts
 * were not ready yet; on the shop's PC there is no PDF reader to look, so the rehearsal opens the
 * PDF's compressed page streams itself and looks for a text-drawing operator (Tj or TJ). Which
 * fields each document must print is checked in CI with the real text (print-documents.test.ts).
 */
import { inflateSync } from 'node:zlib';

export function isPdf(file: Buffer): boolean {
  return file.subarray(0, 5).toString('latin1') === '%PDF-';
}

export function pdfHasText(file: Buffer): boolean {
  let at = 0;
  for (;;) {
    const keyword = file.indexOf('stream', at, 'latin1');
    if (keyword === -1) return false;
    let start = keyword + 'stream'.length;
    if (file[start] === 0x0d) start++;
    if (file[start] === 0x0a) start++;
    const end = file.indexOf('endstream', start, 'latin1');
    if (end === -1) return false;
    try {
      const content = inflateSync(file.subarray(start, end)).toString('latin1');
      if (/(^|[\s\]>)])T[Jj](\s|$)/m.test(content)) return true;
    } catch {
      // Not a compressed stream (an image, a font): look at the next one.
    }
    at = end + 'endstream'.length;
  }
}
