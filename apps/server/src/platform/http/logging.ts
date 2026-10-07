/**
 * Logging that never contains secrets (golden rule 13). Request bodies are never logged; secret
 * headers are redacted; database errors lose their `detail` (it can contain row values).
 */
export const DEVICE_HEADER = 'x-artepool-device';
export const CLIENT_VERSION_HEADER = 'x-artepool-client';
export const BACKGROUND_HEADER = 'x-artepool-background';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  `req.headers["${DEVICE_HEADER}"]`,
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.pin',
  '*.newPin',
  '*.code',
  '*.token',
  '*.secret',
  '*.deviceKey',
  '*.totp',
];

/** Fields of an error that are safe to log (no row values, queries or hints). */
const SAFE_ERROR_FIELDS = ['code', 'constraint', 'table', 'column', 'schema', 'routine'] as const;

export interface SafeError {
  type: string;
  message: string;
  stack: string;
  cause?: SafeError;
  [field: string]: unknown;
}

export function safeErrorSerializer(error: unknown, depth = 0): SafeError {
  if (!(error instanceof Error))
    return { type: typeof error, message: '[non-error value]', stack: '' };
  const out: SafeError = { type: error.name, message: error.message, stack: error.stack ?? '' };
  for (const field of SAFE_ERROR_FIELDS) {
    const value = (error as unknown as Record<string, unknown>)[field];
    if (typeof value === 'string' || typeof value === 'number') out[field] = value;
  }
  if (error.cause !== undefined && depth < 3)
    out.cause = safeErrorSerializer(error.cause, depth + 1);
  return out;
}
