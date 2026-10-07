import { describe, expect, it } from 'vitest';
import { ERROR_CODES, errorCodeForSqlState, SQLSTATE_TO_ERROR_CODE } from '../src/errors';

describe('error codes', () => {
  it('maps database rule codes and falls back to INTERNAL', () => {
    expect(errorCodeForSqlState('AP001')).toBe('CONTEXT_MISSING');
    expect(errorCodeForSqlState('23505')).toBe('DUPLICATE');
    expect(errorCodeForSqlState('XX000')).toBe('INTERNAL');
    expect(errorCodeForSqlState(undefined)).toBe('INTERNAL');
  });

  it('only maps to known codes', () => {
    for (const code of Object.values(SQLSTATE_TO_ERROR_CODE)) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});
