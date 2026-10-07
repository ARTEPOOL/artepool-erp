import { describe, expect, it } from 'vitest';
import { BridgePath, BridgeRequest } from '../src/contracts';

describe('bridge requests', () => {
  it('reach only API paths, never another site or a dot segment', () => {
    expect(BridgePath.safeParse('/api/v1/auth/me').success).toBe(true);
    expect(BridgePath.safeParse('/api/v1/audit?limit=50&kind=security').success).toBe(true);
    expect(BridgePath.safeParse('/health').success).toBe(true);
    for (const bad of [
      'https://evil.example/api/v1/x',
      '//evil.example/api/v1',
      '/api/v1/../../etc',
      '/admin',
      '/api/v2/x',
      '/api/v1/a b',
    ]) {
      expect(BridgePath.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('carry only a well-formed token and idempotency key', () => {
    const base = { method: 'POST', path: '/api/v1/auth/lock' };
    expect(BridgeRequest.safeParse({ ...base, token: 'abc_DEF-123' }).success).toBe(true);
    expect(BridgeRequest.safeParse({ ...base, token: 'a\r\nx-evil: 1' }).success).toBe(false);
    expect(BridgeRequest.safeParse({ ...base, idempotencyKey: 'not-a-uuid' }).success).toBe(false);
    expect(BridgeRequest.safeParse({ ...base, method: 'DELETE' }).success).toBe(false);
  });
});
