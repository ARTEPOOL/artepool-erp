/**
 * The PDF copy of a thermal receipt (decision 0120): the same 1-bit image the printer gets, on one
 * page the paper's width (80 mm, or 58 mm for the narrow roll), saved by the Windows side into
 * Public Documents\ARTEPOOL\Receipts\<YYYY-MM>\ — one file per document, never overwritten.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { toBase64 } from './escpos';

/** The receipt image as the printer gets it: rows of 1-bit dots (1 = black), most significant first. */
export interface ReceiptBits {
  bits: Uint8Array;
  widthBytes: number;
  widthDots: number;
  height: number;
}

/** The printer head's resolution: 203 dots per inch. */
const DOTS_PER_INCH = 203;
const POINTS_PER_INCH = 72;
const POINTS_PER_MM = POINTS_PER_INCH / 25.4;
/** White paper above and below the receipt on the page. */
const MARGIN_MM = 4;

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  // "deflate" is the zlib format, which is what a PDF's FlateDecode reads.
  const compressor = new CompressionStream('deflate');
  const writer = compressor.writable.getWriter();
  void writer.write(data as Uint8Array<ArrayBuffer>);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = compressor.readable.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read())
    chunks.push(read.value);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A number for the PDF: at most two decimals, no exponent. */
const num = (value: number): string => String(Math.round(value * 100) / 100);

/** Only printable ASCII in the title; anything else (and the PDF's own delimiters) is dropped. */
const pdfText = (text: string): string => text.replace(/[^\x20-\x7e]|[()\\]/g, '');

/** A one-page PDF holding the receipt image at its real size. */
export async function receiptPdf(image: ReceiptBits, title: string): Promise<Uint8Array> {
  const paperMm = image.widthDots > 400 ? 80 : 58;
  const pageWidth = paperMm * POINTS_PER_MM;
  const imageWidth = (image.widthDots / DOTS_PER_INCH) * POINTS_PER_INCH;
  const imageHeight = (image.height / DOTS_PER_INCH) * POINTS_PER_INCH;
  const margin = MARGIN_MM * POINTS_PER_MM;
  const pageHeight = imageHeight + 2 * margin;
  const x = (pageWidth - imageWidth) / 2;

  const pixels = await deflate(image.bits.subarray(0, image.widthBytes * image.height));
  const content = new TextEncoder().encode(
    `q ${num(imageWidth)} 0 0 ${num(imageHeight)} ${num(x)} ${num(margin)} cm /Im0 Do Q`,
  );

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (body: string, stream?: Uint8Array) => {
    offsets.push(length);
    push(`${offsets.length} 0 obj\n${body}`);
    if (stream) {
      push('\nstream\n');
      push(stream);
      push('\nendstream');
    }
    push('\nendobj\n');
  };

  // The binary marker line tells readers the file holds binary data.
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  object('<< /Type /Catalog /Pages 2 0 R >>');
  object('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pageWidth)} ${num(pageHeight)}] ` +
      '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
  );
  object(
    `<< /Type /XObject /Subtype /Image /Width ${image.widthDots} /Height ${image.height} ` +
      '/ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [1 0] /Filter /FlateDecode ' +
      `/Length ${pixels.length} >>`,
    pixels,
  );
  object(`<< /Length ${content.length} >>`, content);
  object(`<< /Title (${pdfText(title)}) /Producer (ARTEPOOL ERP) >>`);

  const xref = length;
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  push(
    `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );

  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The copy's month folder and file name: "POS-000123 - 05-11-2026.pdf" in "2026-11". The date is
 * the document's issue date (Asia/Dubai, as the server stored it).
 */
export function receiptPdfName(
  docNumber: string,
  issueDate: string,
): { month: string; fileName: string } {
  const [year, month, day] = issueDate.split('-');
  return { month: `${year}-${month}`, fileName: `${docNumber} - ${day}-${month}-${year}.pdf` };
}

export type ReceiptCopy = 'saved' | 'exists' | 'failed' | 'browser';

/**
 * Saves the receipt's PDF copy on this PC, unless that document already has one (a reprint only
 * puts back a missing file). Never throws: a failed copy never stops or undoes a sale.
 */
export async function saveReceiptCopy(
  image: ReceiptBits,
  document: { docNumber: string | null; issueDate: string | null },
): Promise<ReceiptCopy> {
  if (!isTauri()) return 'browser';
  if (!document.docNumber || !document.issueDate) return 'failed';
  try {
    const { month, fileName } = receiptPdfName(document.docNumber, document.issueDate);
    const pdf = await receiptPdf(image, document.docNumber);
    return await invoke<'saved' | 'exists'>('receipt_pdf_save', {
      month,
      fileName,
      dataBase64: toBase64(pdf),
    });
  } catch {
    return 'failed';
  }
}
