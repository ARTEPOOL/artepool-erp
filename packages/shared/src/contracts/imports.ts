/**
 * Excel import (decision 0031): Check reads the whole file and saves nothing; Import saves every
 * row in one transaction, only for a file that was checked without problems and has not changed.
 */
import { z } from 'zod';

export const IMPORT_ENTITIES = ['items', 'item_prices', 'customers', 'suppliers'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

/** At most 5 MB of Excel, sent as base64 inside JSON. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;

export const ImportFileRequest = z.object({
  fileName: z.string().trim().min(1).max(200),
  dataBase64: z
    .string()
    .min(1)
    .max(Math.ceil((IMPORT_MAX_BYTES * 4) / 3) + 4),
});
export type ImportFileRequest = z.infer<typeof ImportFileRequest>;

/** What is wrong with one cell or row; translated by the app (`imports.problems.<code>`). */
export const IMPORT_PROBLEMS = [
  'required',
  'invalid',
  'too_long',
  'invalid_code',
  'invalid_number',
  'invalid_price',
  'invalid_quantity',
  'invalid_trn',
  'invalid_phone',
  'invalid_email',
  'invalid_choice',
  'duplicate_in_file',
  'already_exists',
  'unknown_reference',
  'inactive_reference',
  'price_required',
  'stock_fields_for_stock_only',
  'too_many_decimals',
  'trn_needs_registration',
] as const;
export type ImportProblem = (typeof IMPORT_PROBLEMS)[number];

export interface ImportIssue {
  /** The Excel row number (the header is row 1). */
  row: number;
  /** The column header as in the template, or null for the whole row. */
  column: string | null;
  problem: ImportProblem;
}

export interface ImportCheckResponse {
  batchId: string;
  entity: ImportEntity;
  status: 'validated' | 'rejected';
  rowsTotal: number;
  rowsValid: number;
  rowsInvalid: number;
  /** Every problem found (at most 1,000 are listed). */
  issues: ImportIssue[];
  issuesTotal: number;
}

export const ImportCommitRequest = ImportFileRequest;
export type ImportCommitRequest = ImportFileRequest;

export interface ImportCommitResponse {
  batchId: string;
  imported: number;
}

export type ImportFileProblem =
  'not_excel' | 'too_large' | 'too_many_rows' | 'wrong_template' | 'empty';
