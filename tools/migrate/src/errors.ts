export type MigrationErrorCode =
  | 'ALREADY_RUNNING'
  | 'BAD_FILE_NAME'
  | 'NUMBERING_GAP'
  | 'FORBIDDEN_STATEMENT'
  | 'MISSING_FILE'
  | 'CHECKSUM_MISMATCH'
  | 'FAILED';

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
  ) {
    super(message);
  }
}
