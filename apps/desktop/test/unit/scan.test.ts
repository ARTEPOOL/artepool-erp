// @vitest-environment node
/**
 * Scanners in search fields: letters a scanner types while Windows is on the Arabic keyboard come
 * back as the keys pressed; a scan is told apart from a person typing by its speed.
 */
import { describe, expect, it } from 'vitest';
import { fromArabicKeyboard, isScanBurst } from '../../src/features/items/scan';

describe('letters typed with the Arabic keyboard', () => {
  it('turn back into the code that was scanned', () => {
    // The owner's test label: TEST-1234 (T = لإ, E = ُ, S = ٍ with Shift).
    expect(fromArabicKeyboard('لإٍُلإ-1234')).toBe('TEST-1234');
    // Lower-case letters (no Shift): "chem-0012".
    expect(fromArabicKeyboard('ؤاثة-0012')).toBe('chem-0012');
    // Real scans in the owner's shop: X001JBWYZV (Shift+Z gives "~", Shift+V "{"), and a UAE
    // EAN-13 (digits only, unchanged).
    expect(fromArabicKeyboard('\u0652001ـلآ\u064Bإ~{')).toBe('X001JBWYZV');
    expect(fromArabicKeyboard('6297000711423')).toBe('6297000711423');
    // G and B are lam-alef keys too.
    expect(fromArabicKeyboard('لأ1لآ2')).toBe('G1B2');
    // Digits only: nothing to do.
    expect(fromArabicKeyboard('6291041500213')).toBe('6291041500213');
  });

  it('leaves Latin text and text that is not keyboard letters alone', () => {
    expect(fromArabicKeyboard('CHEM-0012')).toBe('CHEM-0012');
    // A space is not a barcode character: an Arabic phrase is not turned into keys.
    expect(fromArabicKeyboard('كلور حبيبات')).toBe('كلور حبيبات');
    // An Arabic-Indic digit is not on these keys.
    expect(fromArabicKeyboard('كلور٥')).toBe('كلور٥');
  });
});

describe('a scan or a person typing', () => {
  it('a scanner types many keys a few milliseconds apart; a person does not', () => {
    expect(isScanBurst([0, 8, 15, 22, 30, 41])).toBe(true);
    expect(isScanBurst([0, 120, 260, 390, 500])).toBe(false);
    expect(isScanBurst([0, 5, 10])).toBe(false); // too short to tell
  });
});
