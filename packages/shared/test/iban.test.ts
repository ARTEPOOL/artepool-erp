import { describe, expect, it } from 'vitest';
import { formatIban, normalizeSwift, normalizeUaeIban } from '../src/masterdata/index';

describe('UAE IBAN (decision 0065)', () => {
  it('accepts AE + 21 digits with a right checksum, typed with spaces, lower case or Arabic digits', () => {
    expect(normalizeUaeIban('AE070331234567890123456')).toBe('AE070331234567890123456');
    expect(normalizeUaeIban('ae07 0331 2345 6789 0123 456')).toBe('AE070331234567890123456');
    expect(normalizeUaeIban('AE٠٧٠٣٣١٢٣٤٥٦٧٨٩٠١٢٣٤٥٦')).toBe('AE070331234567890123456');
  });

  it('refuses a wrong checksum, length or country', () => {
    expect(normalizeUaeIban('AE070331234567890123457')).toBeNull();
    expect(normalizeUaeIban('AE07033123456789012345')).toBeNull();
    expect(normalizeUaeIban('GB82WEST12345698765432')).toBeNull();
    expect(normalizeUaeIban('')).toBeNull();
  });

  it('prints in groups of four', () => {
    expect(formatIban('AE070331234567890123456')).toBe('AE07 0331 2345 6789 0123 456');
  });

  it('SWIFT: 8 or 11 characters', () => {
    expect(normalizeSwift('ebil aead')).toBe('EBILAEAD');
    expect(normalizeSwift('EBILAEADXXX')).toBe('EBILAEADXXX');
    expect(normalizeSwift('EBIL')).toBeNull();
  });
});
