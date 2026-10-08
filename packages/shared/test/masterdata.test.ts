import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  fitsUnitDecimals,
  formatPhone,
  formatPrice,
  nextCode,
  normalizeCode,
  normalizePhone,
  normalizeTrn,
  quantityFromDb,
  quantityToDb,
  unitPriceBreakdown,
} from '../src/masterdata';
import { parse4dp } from '../src/money';

describe('TRN (decision 0037)', () => {
  it('accepts 15 digits starting with 100, typed with spaces, dashes or Arabic digits', () => {
    expect(normalizeTrn('100123456789012')).toBe('100123456789012');
    expect(normalizeTrn(' 100-1234-5678-9012 ')).toBe('100123456789012');
    expect(normalizeTrn('١٠٠١٢٣٤٥٦٧٨٩٠١٢')).toBe('100123456789012');
  });

  it('refuses anything else', () => {
    for (const bad of [
      '200123456789012',
      '10012345678901',
      '1001234567890123',
      '100abc456789012',
      '',
    ]) {
      expect(normalizeTrn(bad)).toBeNull();
    }
  });
});

describe('phone numbers', () => {
  it('turns local UAE numbers into the international form', () => {
    expect(normalizePhone('050 123 4567')).toBe('+971501234567');
    expect(normalizePhone('0501234567')).toBe('+971501234567');
    expect(normalizePhone('+971 50 123 4567')).toBe('+971501234567');
    expect(normalizePhone('00971501234567')).toBe('+971501234567');
    expect(normalizePhone('971501234567')).toBe('+971501234567');
    expect(normalizePhone('٠٥٠١٢٣٤٥٦٧')).toBe('+971501234567');
    expect(normalizePhone('03 765 4321')).toBe('+97137654321');
    expect(normalizePhone('+20 100 123 4567')).toBe('+201001234567');
  });

  it('refuses numbers that cannot be right', () => {
    for (const bad of [
      '12345',
      '050123456',
      '05012345678',
      '+9715012345',
      'phone',
      '+971 1 234 5678',
    ]) {
      expect(normalizePhone(bad)).toBeNull();
    }
  });

  it('shows UAE numbers the local way', () => {
    expect(formatPhone('+971501234567')).toBe('050 123 4567');
    expect(formatPhone('+97137654321')).toBe('03 765 4321');
    expect(formatPhone('+201001234567')).toBe('+201001234567');
  });

  it('every valid result is normalised again to itself', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^05[0-9]{8}$/), (local) => {
        const e164 = normalizePhone(local)!;
        expect(normalizePhone(e164)).toBe(e164);
        expect(normalizePhone(formatPhone(e164))).toBe(e164);
      }),
    );
  });
});

describe('codes', () => {
  it('suggests the next free code per prefix', () => {
    expect(nextCode('CHEM', [])).toBe('CHEM-0001');
    expect(nextCode('CHEM', ['CHEM-0001', 'chem-0012', 'EQUIP-0099', 'CHEM-X'])).toBe('CHEM-0013');
    expect(nextCode('EQUIP', ['EQUIP-123456'])).toBe('EQUIP-123457');
    expect(nextCode('A.B', ['A.B-9', 'AXB-50'])).toBe('A.B-0010');
  });

  it('stores codes trimmed, in capitals, with plain digits', () => {
    expect(normalizeCode(' chem-٠١ ')).toBe('CHEM-01');
  });
});

describe('quantities and units', () => {
  it('fit the unit decimals', () => {
    expect(fitsUnitDecimals(5000n, 0)).toBe(true);
    expect(fitsUnitDecimals(1500n, 0)).toBe(false);
    expect(fitsUnitDecimals(1500n, 1)).toBe(true);
    expect(fitsUnitDecimals(1250n, 1)).toBe(false);
    expect(fitsUnitDecimals(1234n, 3)).toBe(true);
  });

  it('round-trip the database text exactly', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 99_999_999_999_999n }), (milli) => {
        expect(quantityFromDb(quantityToDb(milli))).toBe(milli);
      }),
    );
    expect(quantityFromDb('5.000')).toBe(5000n);
  });
});

describe('one sale price with a "price includes VAT" switch (decision 0032)', () => {
  it('splits an inclusive price back into net and VAT (decision 0009 example)', () => {
    expect(unitPriceBreakdown(parse4dp('9.99'), true, 500n)).toEqual({
      netFils: 951n,
      vatFils: 48n,
      grossFils: 999n,
    });
  });

  it('adds VAT on top of an exclusive price', () => {
    expect(unitPriceBreakdown(parse4dp('12.5'), false, 500n)).toEqual({
      netFils: 1250n,
      vatFils: 63n,
      grossFils: 1313n,
    });
    expect(unitPriceBreakdown(parse4dp('100'), false, 0n)).toEqual({
      netFils: 10000n,
      vatFils: 0n,
      grossFils: 10000n,
    });
  });

  it('always shows net + VAT = total, exact to the fils', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000_000_000n }),
        fc.boolean(),
        fc.constantFrom(0n, 500n, 1000n),
        (price4dp, includesVat, rate) => {
          const b = unitPriceBreakdown(price4dp, includesVat, rate);
          expect(b.netFils + b.vatFils).toBe(b.grossFils);
          expect(b.vatFils >= 0n && b.netFils >= 0n).toBe(true);
        },
      ),
    );
  });

  it('shows two decimals unless more were entered', () => {
    expect(formatPrice(125000n)).toBe('12.50');
    expect(formatPrice(12345n)).toBe('1.2345');
    expect(formatPrice(12340n)).toBe('1.234');
    expect(formatPrice(0n)).toBe('0.00');
    expect(formatPrice(10_000_000n)).toBe('1000.00');
  });
});
