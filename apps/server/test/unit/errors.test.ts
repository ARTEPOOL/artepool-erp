import { describe, expect, it } from 'vitest';
import { MoneyRuleError } from '@artepool/shared';
import { AppError, isRetryable, toAppError } from '../../src/platform/errors/app-error';

describe('error mapping', () => {
  it('maps database rule violations to app error codes and HTTP statuses', () => {
    expect(toAppError({ code: '23505', message: 'duplicate key' })).toMatchObject({
      code: 'DUPLICATE',
      httpStatus: 409,
    });
    expect(toAppError({ code: 'AP002', message: 'no delete' })).toMatchObject({
      code: 'DELETE_FORBIDDEN',
      httpStatus: 409,
    });
    expect(toAppError({ code: '42501', message: 'permission denied' })).toMatchObject({
      code: 'PERMISSION_DENIED',
      httpStatus: 403,
    });
  });

  it('maps money errors and keeps AppErrors as they are', () => {
    expect(toAppError(new MoneyRuleError('too much discount'))).toMatchObject({
      code: 'MONEY_RULE',
      httpStatus: 422,
    });
    const original = new AppError('TIMEOUT', 'slow');
    expect(toAppError(original)).toBe(original);
  });

  it('treats anything unknown as INTERNAL', () => {
    expect(toAppError(new Error('boom'))).toMatchObject({ code: 'INTERNAL', httpStatus: 500 });
    expect(toAppError('weird')).toMatchObject({ code: 'INTERNAL' });
  });

  it('knows which database errors are safe to retry', () => {
    expect(isRetryable({ code: '40P01' })).toBe(true);
    expect(isRetryable({ code: '40001' })).toBe(true);
    expect(isRetryable({ code: '23505' })).toBe(false);
    expect(isRetryable(new Error('x'))).toBe(false);
  });
});
