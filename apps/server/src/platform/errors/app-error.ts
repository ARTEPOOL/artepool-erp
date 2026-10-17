import {
  errorCodeForSqlState,
  isRuleCode,
  MoneyFormatError,
  MoneyRuleError,
  type ErrorCode,
  type RuleCode,
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
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 423,
  INVALID_PIN: 401,
  PIN_BLOCKED: 403,
  APPROVAL_BLOCKED: 403,
  INVALID_TWO_STEP_CODE: 401,
  RECOVERY_REFUSED: 401,
  PASSWORD_REJECTED: 422,
  PIN_REJECTED: 422,
  ENROLLMENT_FAILED: 401,
  ENROLLMENT_UNAVAILABLE: 503,
  DEVICE_CODE_TAKEN: 409,
  DEVICE_PROTECTED: 409,
  VALIDATION_FAILED: 422,
  DUPLICATE: 409,
  REFERENCE_MISSING: 422,
  PERMISSION_DENIED: 403,
  BUSY_RETRY: 503,
  TIMEOUT: 503,
  MONEY_FORMAT: 422,
  MONEY_RULE: 422,
  RULE_VIOLATION: 422,
  STALE_VERSION: 409,
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

/** A broken business rule, translated by the app as `errors.rules.<rule>`. */
export function ruleError(rule: RuleCode, message: string, details: Record<string, unknown> = {}) {
  return new AppError('RULE_VIOLATION', message, { rule, ...details });
}

/**
 * Unique indexes → the form field the duplicate is about, so the screen can show the message
 * under that field. Index names never reach the client.
 */
const DUPLICATE_FIELDS: Readonly<Record<string, string>> = {
  accounts_code_uq: 'code',
  business_lines_code_uq: 'code',
  units_code_uq: 'code',
  item_categories_code_uq: 'code',
  items_code_uq: 'code',
  item_barcodes_active_uq: 'barcodes',
  customers_code_uq: 'code',
  customers_phone_uq: 'phone',
  customers_trn_uq: 'trn',
  suppliers_code_uq: 'code',
  suppliers_trn_uq: 'trn',
  technicians_code_uq: 'code',
  label_sizes_code_uq: 'code',
  technicians_user_id_key: 'userId',
  payment_methods_code_uq: 'code',
  warehouses_code_uq: 'code',
  reason_codes_code_uq: 'code',
  series_prefix_uq: 'prefix',
  company_bank_accounts_iban_uq: 'iban',
};

/** Extra, safe details of a database error: the broken rule, or the duplicate field. */
function databaseDetails(error: unknown, state: string): Record<string, unknown> {
  const e = error as { hint?: unknown; detail?: unknown; constraint?: unknown };
  if ((state === 'AP011' || state === 'AP012') && isRuleCode(e.hint)) {
    // DETAIL carries a short machine word (e.g. why an account is in use), never data.
    const why = typeof e.detail === 'string' && /^[a-z_]{1,40}$/.test(e.detail) ? e.detail : null;
    return why ? { rule: e.hint, why } : { rule: e.hint };
  }
  if (state === '23505' && typeof e.constraint === 'string' && DUPLICATE_FIELDS[e.constraint]) {
    return { field: DUPLICATE_FIELDS[e.constraint] };
  }
  return {};
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
      { sqlState: state, ...databaseDetails(error, state) },
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
