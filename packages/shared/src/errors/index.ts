/**
 * Error codes shared by the server and the desktop app. The app translates each code
 * through i18n (`errors.<CODE>` in packages/i18n), so no error text is hard-coded.
 */
export const ERROR_CODES = [
  'CONTEXT_MISSING',
  'DELETE_FORBIDDEN',
  'ROW_IMMUTABLE',
  'AUDIT_PROTECTED',
  'NUMBERING_TAMPER',
  'DRAFT_REQUIRED',
  'SERIES_NOT_FOUND',
  'OWNER_PROTECTED',
  'APPROVAL_INVALID',
  'SIGN_IN_NOT_ALLOWED',
  'VALIDATION_FAILED',
  'DUPLICATE',
  'REFERENCE_MISSING',
  'PERMISSION_DENIED',
  'BUSY_RETRY',
  'TIMEOUT',
  'MONEY_FORMAT',
  'MONEY_RULE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * PostgreSQL SQLSTATE → error code. Codes AP001–AP099 are raised by ARTÉPOOL's own
 * database rules (see db/migrations); the others are standard PostgreSQL codes.
 */
export const SQLSTATE_TO_ERROR_CODE: Readonly<Record<string, ErrorCode>> = {
  AP001: 'CONTEXT_MISSING',
  AP002: 'DELETE_FORBIDDEN',
  AP003: 'ROW_IMMUTABLE',
  AP004: 'AUDIT_PROTECTED',
  AP005: 'NUMBERING_TAMPER',
  AP006: 'DRAFT_REQUIRED',
  AP007: 'SERIES_NOT_FOUND',
  AP008: 'OWNER_PROTECTED',
  AP009: 'APPROVAL_INVALID',
  AP010: 'SIGN_IN_NOT_ALLOWED',
  '22P02': 'VALIDATION_FAILED',
  '23502': 'VALIDATION_FAILED',
  '23514': 'VALIDATION_FAILED',
  '23505': 'DUPLICATE',
  '23503': 'REFERENCE_MISSING',
  '42501': 'PERMISSION_DENIED',
  '40001': 'BUSY_RETRY',
  '40P01': 'BUSY_RETRY',
  '55P03': 'BUSY_RETRY',
  '57014': 'TIMEOUT',
};

export function errorCodeForSqlState(sqlState: string | undefined): ErrorCode {
  return (sqlState && SQLSTATE_TO_ERROR_CODE[sqlState]) || 'INTERNAL';
}
