/** Which version is newer (decision 0110): the version running is never shown as a new one. */
import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../src/contracts/updates';

describe('isNewerVersion', () => {
  it('compares x.y.z versions number by number', () => {
    expect(isNewerVersion('0.4.0', '0.3.0')).toBe(true);
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.3.0', '0.3.0')).toBe(false);
    expect(isNewerVersion('0.2.9', '0.3.0')).toBe(false);
  });

  it('treats an unknown running version as older, and a bad one as never newer', () => {
    expect(isNewerVersion('0.3.0', null)).toBe(true);
    expect(isNewerVersion('0.3', '0.2.0')).toBe(false);
  });
});
