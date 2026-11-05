/**
 * The receipt's PDF copy (decision 0120): one page the paper's width holding exactly the image the
 * printer gets, a valid cross-reference table, and the copy's folder and file name.
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { receiptPdf, receiptPdfName } from '../../src/features/pos/receipt/pdf';

/** A small receipt image: 576 dots wide (80 mm head), a few rows of a pattern. */
function sampleImage(height = 40) {
  const widthDots = 576;
  const widthBytes = widthDots / 8;
  const bits = new Uint8Array(widthBytes * height);
  for (let i = 0; i < bits.length; i += 1) bits[i] = (i * 37) & 0xff;
  return { bits, widthBytes, widthDots, height };
}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

describe('receipt PDF copy', () => {
  it('is a one-page PDF the width of 80 mm paper, the image at the head’s real size', async () => {
    const image = sampleImage(406); // 406 dots = 2 inches = 144 pt
    const pdf = latin1(await receiptPdf(image, 'POS-000123'));
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('/Count 1');
    // 80 mm = 226.77 pt wide; 144 pt of receipt + 4 mm above and below.
    expect(pdf).toContain('/MediaBox [0 0 226.77 166.68]');
    // 576 dots at 203 dpi = 204.3 pt, centred.
    expect(pdf).toContain('q 204.3 0 0 144 11.24 11.34 cm /Im0 Do Q');
    expect(pdf).toContain('/Width 576 /Height 406 /ColorSpace /DeviceGray /BitsPerComponent 1');
    expect(pdf).toContain('/Title (POS-000123)');
  });

  it('holds exactly the printer’s dots (1 = black)', async () => {
    const image = sampleImage();
    const bytes = await receiptPdf(image, 'POS-1');
    const pdf = latin1(bytes);
    expect(pdf).toContain('/Decode [1 0]');
    const length = Number(/\/Image [^>]*\/Length (\d+) >>/.exec(pdf)![1]);
    const start = pdf.indexOf('stream\n', pdf.indexOf('/Subtype /Image')) + 'stream\n'.length;
    const pixels = inflateSync(Buffer.from(bytes.subarray(start, start + length)));
    expect(new Uint8Array(pixels)).toEqual(image.bits);
  });

  it('has a cross-reference table that points at every object', async () => {
    const pdf = latin1(await receiptPdf(sampleImage(), 'CN-000004'));
    const xref = Number(/startxref\n(\d+)\n/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    const entries = [...pdf.slice(xref).matchAll(/(\d{10}) 00000 n \n/g)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(6);
    entries.forEach((offset, i) =>
      expect(pdf.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true),
    );
  });

  it('uses the narrow page for a 58 mm roll', async () => {
    const pdf = latin1(
      await receiptPdf(
        { bits: new Uint8Array(48 * 10), widthBytes: 48, widthDots: 384, height: 10 },
        'POS-2',
      ),
    );
    expect(pdf).toContain('/MediaBox [0 0 164.41 ');
  });

  it('keeps only plain text in the title', async () => {
    const pdf = latin1(await receiptPdf(sampleImage(), 'POS-1) /Evil (x'));
    expect(pdf).toContain('/Title (POS-1 /Evil x)');
  });

  it('names the copy after the document and its issue date', () => {
    expect(receiptPdfName('POS-000123', '2026-11-05')).toEqual({
      month: '2026-11',
      fileName: 'POS-000123 - 05-11-2026.pdf',
    });
    expect(receiptPdfName('CN-000004', '2026-12-31')).toEqual({
      month: '2026-12',
      fileName: 'CN-000004 - 31-12-2026.pdf',
    });
  });
});
