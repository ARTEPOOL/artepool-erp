/**
 * The test upgrades (M6.2 part G2): the next patch numbers after the real version, and a file
 * name that says it is a test version, never for the shop.
 */
import { describe, expect, it } from 'vitest';
import { nextPatch, testSetupFileName } from '../../src/build';

describe('the test upgrades', () => {
  it('number the next patch versions', () => {
    expect(nextPatch('0.6.2', 1)).toBe('0.6.3');
    expect(nextPatch('1.9.9', 2)).toBe('1.9.11');
  });

  it('are named -TEST', () => {
    expect(testSetupFileName('0.4.1')).toBe('ARTEPOOL-Server-Setup-0.4.1-TEST.exe');
  });
});
