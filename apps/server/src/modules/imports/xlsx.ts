/**
 * Reading and writing Excel (.xlsx) files for the import templates (decision 0031) and exports.
 * An uploaded file is checked before it is opened: size, ZIP structure and how much it would
 * expand, so a crafted file cannot exhaust the server's memory.
 */
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';

const MAX_UNCOMPRESSED_BYTES = 60 * 1024 * 1024;
const MAX_ENTRIES = 500;
const MAX_RATIO = 200;

export class ExcelFileError extends Error {
  constructor(
    readonly problem: 'not_excel' | 'too_large' | 'too_many_rows' | 'wrong_template' | 'empty',
  ) {
    super(`Excel file refused: ${problem}`);
  }
}

/**
 * Reads the ZIP central directory (an .xlsx is a ZIP file) and refuses files that would expand
 * too much. Sizes are checked again while reading, since a header can lie.
 */
export function assertSafeZip(file: Buffer): void {
  const eocdMin = 22;
  if (file.length < eocdMin || file.readUInt32LE(0) !== 0x04034b50)
    throw new ExcelFileError('not_excel');
  let eocd = -1;
  for (let i = file.length - eocdMin; i >= Math.max(0, file.length - eocdMin - 0xffff); i--) {
    if (file.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ExcelFileError('not_excel');
  const entries = file.readUInt16LE(eocd + 10);
  const directoryOffset = file.readUInt32LE(eocd + 16);
  if (entries === 0 || entries > MAX_ENTRIES) throw new ExcelFileError('not_excel');
  let offset = directoryOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > file.length || file.readUInt32LE(offset) !== 0x02014b50) {
      throw new ExcelFileError('not_excel');
    }
    const compressed = file.readUInt32LE(offset + 20);
    const uncompressed = file.readUInt32LE(offset + 24);
    total += uncompressed;
    if (uncompressed > MAX_UNCOMPRESSED_BYTES || total > MAX_UNCOMPRESSED_BYTES) {
      throw new ExcelFileError('too_large');
    }
    if (uncompressed > 1024 * 1024 && uncompressed / Math.max(compressed, 1) > MAX_RATIO) {
      throw new ExcelFileError('too_large');
    }
    offset +=
      46 +
      file.readUInt16LE(offset + 28) +
      file.readUInt16LE(offset + 30) +
      file.readUInt16LE(offset + 32);
  }
}

export interface ColumnSpec {
  key: string;
  ar: string;
  en: string;
}

/** The header shown in a template: "Arabic / English". */
export const headerOf = (column: ColumnSpec): string => `${column.ar} / ${column.en}`;

const normalizeHeader = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

/** Plain text of a cell, whatever Excel stored (numbers, rich text, formulas, dates). */
function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) return cellText(value.richText.map((r) => r.text).join(''));
    if ('text' in value && typeof value.text === 'string') return cellText(value.text);
    if ('result' in value) return cellText(value.result);
  }
  return null;
}

/** One cell of a row by column key; null when empty or not in the file. */
export const cell = (row: SheetRow, key: string): string | null => row.values[key] ?? null;

export interface SheetRow {
  /** The Excel row number (the header is row 1). */
  row: number;
  values: Record<string, string | null>;
}

/**
 * The rows of the first sheet, by column key. Headers may be the template's "Arabic / English"
 * text, or either language alone; unknown columns are ignored; empty rows are skipped.
 */
export async function readRows(
  file: Buffer,
  columns: readonly ColumnSpec[],
  maxRows: number,
): Promise<SheetRow[]> {
  assertSafeZip(file);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.read(Readable.from([file]));
  } catch {
    throw new ExcelFileError('not_excel');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 1) throw new ExcelFileError('empty');
  if (sheet.rowCount - 1 > maxRows) throw new ExcelFileError('too_many_rows');

  const keyOfColumn = new Map<number, string>();
  sheet.getRow(1).eachCell((cell, col) => {
    const header = normalizeHeader(cellText(cell.value) ?? '');
    const parts = [header, ...header.split('/').map((p) => p.trim())];
    const match = columns.find((c) =>
      parts.some((p) => p === normalizeHeader(c.ar) || p === normalizeHeader(c.en) || p === c.key),
    );
    if (match && ![...keyOfColumn.values()].includes(match.key)) keyOfColumn.set(col, match.key);
  });
  if (keyOfColumn.size === 0) throw new ExcelFileError('wrong_template');

  const rows: SheetRow[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const values: Record<string, string | null> = Object.fromEntries(
      columns.map((c) => [c.key, null]),
    );
    let any = false;
    for (const [col, key] of keyOfColumn) {
      const text = cellText(row.getCell(col).value);
      values[key] = text;
      if (text !== null) any = true;
    }
    if (any) rows.push({ row: r, values });
  }
  if (rows.length === 0) throw new ExcelFileError('empty');
  return rows;
}

export interface SheetSpec {
  name: string;
  columns: readonly ColumnSpec[];
  /** Columns kept as text, so Excel never drops a leading 0 (phones, codes, barcodes, TRNs). */
  textColumns?: readonly string[];
  rows?: readonly (readonly (string | number | null)[])[];
  rightToLeft?: boolean;
}

/** A workbook with one or more sheets; the first row of each is a bold header. */
export async function writeWorkbook(sheets: readonly SheetSpec[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ARTÉPOOL ERP';
  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name, {
      views: [{ state: 'frozen', ySplit: 1, rightToLeft: spec.rightToLeft ?? false }],
    });
    sheet.columns = spec.columns.map((c) => ({
      header: headerOf(c),
      key: c.key,
      width: Math.max(16, headerOf(c).length + 4),
      ...(spec.textColumns?.includes(c.key) ? { style: { numFmt: '@' } } : {}),
    }));
    sheet.getRow(1).font = { bold: true };
    for (const row of spec.rows ?? []) sheet.addRow([...row]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
