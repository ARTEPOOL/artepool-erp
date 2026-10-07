import {
  errorCodeForSqlState,
  MoneyFormatError,
  MoneyRuleError,
  type ErrorCode,
} from '@artepool/shared';

const HTTP_STATUS: Record<ErrorCode, number> = {
  CONTEXT_MISSING: 500,
  DELETE_FORBIDDEN: 409,
  ROW_IMMUTABLE: 409,
  AUDIT_PROTECTED: 409,
  NUMBERING_TAMPER: 409,
  DRAFT_REQUIRED: 409,
  SERIES_NOT_FOUND: 422,
  OWNER_PROTECTED: 409,
  APPROVAL_INVALID: 403,
  SIGN_IN_NOT_ALLOWED: 403,
  DEVICE_NOT_ENROLLED: 401,
  DEVICE_REVOKED: 403,
  DEVICE_KEY_EXPIRED: 401,
  CLIENT_OUTDATED: 426,
  SESSION_REQUIRED: 401,
  SESSION_EXPIRED: 401,
  SESSION_LOCKED: 423,
  SECOND_FACTOR_REQUIRED: 401,
  CREDENTIAL_CHANGE_REQUIRED: 403,
  TWO_STEP_SETUP_REQUIRED: 403,
  IDEMPOTENCY_MISMATCH: 409,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  DUPLICATE: 409,
  REFERENCE_MISSING: 422,
  PERMISSION_DENIED: 403,
  BUSY_RETRY: 503,
  TIMEOUT: 503,
  MONEY_FORMAT: 422,
  MONEY_RULE: 422,
  INTERNAL: 500,
};

/**
 * An error the API can report safely. Clients receive only `code` (translated by the app) and
 * `details`; the message and cause are for the server log only.
 */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly httpStatus: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.httpStatus = HTTP_STATUS[code];
  }
}

function sqlStateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

export function isRetryable(error: unknown): boolean {
  const state = sqlStateOf(error);
  return state === '40P01' || state === '40001';
}

/** Converts any error into an AppError without leaking database details to clients. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof MoneyFormatError || error instanceof MoneyRuleError) {
    return new AppError(error.code, error.message, {}, { cause: error });
  }
  const state = sqlStateOf(error);
  if (state) {
    const message = error instanceof Error ? error.message : String(error);
    return new AppError(
      errorCodeForSqlState(state),
      message,
      { sqlState: state },
      { cause: error },
    );
  }
  return new AppError(
    'INTERNAL',
    error instanceof Error ? error.message : 'Unknown error',
    {},
    { cause: error },
  );
}
