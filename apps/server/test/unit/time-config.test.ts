import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/platform/config';
import { clockSkewSeconds, dubaiDate } from '../../src/platform/time';

describe('Dubai business date', () => {
  it('switches day at 20:00 UTC (midnight in Al Ain)', () => {
    expect(dubaiDate(new Date('2026-10-06T19:59:59Z'))).toBe('2026-10-06');
    expect(dubaiDate(new Date('2026-10-06T20:00:00Z'))).toBe('2026-10-07');
  });

  it('measures PC clock skew in seconds', () => {
    const server = new Date('2026-10-07T08:00:00Z');
    expect(clockSkewSeconds(new Date('2026-10-07T08:02:00Z'), server)).toBe(120);
    expect(clockSkewSeconds(new Date('2026-10-07T07:59:30Z'), server)).toBe(-30);
  });
});

describe('server settings', () => {
  const env = { ARTEPOOL_API_PASSWORD: 'x', ARTEPOOL_DB: 'artepool_dev' };

  it('uses safe defaults: localhost only', () => {
    const config = loadConfig({ ...env });
    expect(config).toMatchObject({ host: '127.0.0.1', port: 3100, logLevel: 'info' });
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ ...env, SERVER_PORT: '70000' })).toThrow();
    expect(() => loadConfig({ ...env, LOG_LEVEL: 'loud' })).toThrow();
  });
});
