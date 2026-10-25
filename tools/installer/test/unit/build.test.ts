/** The test upgrades' versions (M6.2 part G2): the next patch numbers after the real version. */
import { describe, expect, it } from 'vitest';
import { nextPatch } from '../../src/build';

describe('the test upgrades', () => {
  it('number the next patch versions', () => {
    expect(nextPatch('0.6.2', 1)).toBe('0.6.3');
    expect(nextPatch('1.9.9', 2)).toBe('1.9.11');
  });
});
