import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { isPdf, pdfHasText } from '../../src/rehearsal/pdf';

/** A tiny PDF with the given page content and a font stream that is not text. */
function pdf(content: string): Buffer {
  const parts = [
    Buffer.from('%PDF-1.7\n1 0 obj\n<< /Length 9 /Filter /FlateDecode >>\nstream\n', 'latin1'),
    deflateSync(Buffer.from('\x00\x01binary font data TJunk', 'latin1')),
    Buffer.from('\nendstream\nendobj\n2 0 obj\n<< /Filter /FlateDecode >>\nstream\r\n', 'latin1'),
    deflateSync(Buffer.from(content, 'latin1')),
    Buffer.from('\r\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ];
  return Buffer.concat(parts);
}

describe('the rehearsal’s PDF check', () => {
  it('finds text drawn on a page', () => {
    expect(pdfHasText(pdf('q BT /F1 12 Tf 72 712 Td <0102> Tj ET Q'))).toBe(true);
    expect(pdfHasText(pdf('BT /F1 9 Tf [<01> -20 <02>]TJ ET'))).toBe(true);
  });

  it('a page with only shapes, or no streams at all, is blank', () => {
    expect(pdfHasText(pdf('q 0 0 595 842 re f Q'))).toBe(false);
    expect(pdfHasText(Buffer.from('%PDF-1.7\n%%EOF\n'))).toBe(false);
  });

  it('knows a PDF from something else', () => {
    expect(isPdf(pdf(''))).toBe(true);
    expect(isPdf(Buffer.from('<html>'))).toBe(false);
  });
});
