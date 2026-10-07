import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { suggestedCode } from '../../src';
import { sameOrigin } from '../../src/vite-plugin';

const req = (headers: Record<string, string>) =>
  ({ headers: { host: 'localhost:1420', ...headers } }) as unknown as IncomingMessage;

describe('development bridge endpoints', () => {
  it('answer only pages from the same dev server', () => {
    expect(
      sameOrigin(req({ 'sec-fetch-site': 'same-origin', origin: 'http://localhost:1420' })),
    ).toBe(true);
    expect(sameOrigin(req({}))).toBe(true); // a tool on this PC (no browser headers)
    expect(sameOrigin(req({ 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(sameOrigin(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(sameOrigin(req({ origin: 'http://localhost:8080' }))).toBe(false);
    expect(sameOrigin(req({ origin: 'null' }))).toBe(false);
  });

  it('suggests the computer name as the device code', () => {
    expect(suggestedCode('counter-01')).toBe('COUNTER-01');
    expect(suggestedCode('Ahmed’s PC')).toBe('AHMED-S-PC');
    expect(suggestedCode('---')).toBe('PC-01');
    expect(suggestedCode('x'.repeat(40))).toHaveLength(32);
  });
});
