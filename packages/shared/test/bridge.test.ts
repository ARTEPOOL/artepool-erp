import { describe, expect, it } from 'vitest';
import { BridgePath, BridgeRequest, privateKeyIn, RestoreStart } from '../src/contracts';

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

describe('restore from backup', () => {
  const key = `AGE-SECRET-KEY-1${'7'.repeat(58)}`;

  it('finds the private key in a key file, a paste, or a paste without line breaks', () => {
    const file = `# created: 2026-10-01T10:00:00+04:00\n# public key: age1xyz\n${key}\n`;
    expect(privateKeyIn(file)).toBe(key);
    expect(privateKeyIn(`  ${key}  `)).toBe(key);
    expect(privateKeyIn(file.replace(/\n/g, ''))).toBe(key);
    expect(privateKeyIn('age1publickeyisnotsecret')).toBeNull();
    expect(privateKeyIn(key.toLowerCase())).toBeNull();
    expect(privateKeyIn(`${key}X`)).toBeNull();
  });

  it('starts only with a backup copy and a private key (or none for a plain copy)', () => {
    expect(RestoreStart.safeParse({ path: 'E:\\a.dump', privateKey: '' }).success).toBe(true);
    expect(RestoreStart.safeParse({ path: 'D:\\a.dump.age', privateKey: key }).success).toBe(true);
    expect(RestoreStart.safeParse({ path: 'D:\\a.exe', privateKey: '' }).success).toBe(false);
    expect(RestoreStart.safeParse({ path: 'D:\\a.dump', privateKey: 'x' }).success).toBe(false);
  });
});
