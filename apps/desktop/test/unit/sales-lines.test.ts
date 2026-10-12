/**
 * M4-T10: the line editor's arithmetic is the server's (decisions 0009, 0012): typed text is read
 * into exact integers, a percentage discount becomes fils like the server does it, the document
 * discount is spread by the shared helper, optional quotation lines are not counted, and the
 * request carries only what the person changed.
 */
import { describe, expect, it } from 'vitest';
import type { ItemListItem } from '@artepool/shared/contracts';
import {
  lineFromItem,
  preview,
  readLine,
  toRequest,
  type EditorLine,
} from '../../src/features/sales/lines';

const item = (patch: Partial<ItemListItem> = {}): ItemListItem => ({
  id: '1',
  code: 'CHL-01',
  itemType: 'stock',
  nameAr: 'كلور',
  nameEn: 'Chlorine',
  categoryId: '1',
  unitId: 'pcs',
  vatCategoryId: 'sr',
  price: { price4dp: '1000000', includesVat: false },
  primaryBarcode: null,
  isSellable: true,
  isActive: true,
  ...patch,
});

const decimals = (unitId: string) => (unitId === 'kg' ? 3 : 0);
const rateOf = (id: string) => ({ sr: 500, zr: 0 })[id];
const line = (patch: Partial<EditorLine> = {}, from = item()): EditorLine => ({
  ...lineFromItem(from),
  ...patch,
});

describe('sales line editor arithmetic', () => {
  it('reads quantity, price and discount into integers and refuses bad text', () => {
    expect(readLine(line({ quantity: '2' }), 0)).toMatchObject({
      ok: true,
      value: { quantity: 2000n, unitPrice4dp: 1000000n },
    });
    expect(readLine(line({ quantity: '1.5' }), 0)).toEqual({ ok: false, problem: 'decimals' });
    expect(readLine(line({ quantity: '0' }), 0)).toEqual({ ok: false, problem: 'quantity' });
    expect(readLine(line({ unitPrice: 'abc' }), 0)).toEqual({ ok: false, problem: 'price' });
    expect(readLine(line({ discount: '101' }), 0)).toEqual({ ok: false, problem: 'discount' });
    expect(readLine(line({ discountMode: 'amount', discount: '100.01' }), 0)).toEqual({
      ok: false,
      problem: 'discount',
    });
    // Arabic digits are accepted.
    expect(readLine(line({ quantity: '٣' }), 0)).toMatchObject({
      ok: true,
      value: { quantity: 3000n },
    });
  });

  it('turns a percentage into fils with the server rounding (half away from zero)', () => {
    // 3 × 33.3350 = 100.005 → 100.01 AED; 12.5% of 10,001 fils = 1,250.125 → 1,250 fils.
    const r = readLine(line({ quantity: '3', unitPrice: '33.335', discount: '12.5' }), 0);
    expect(r).toMatchObject({
      ok: true,
      value: { amountFils: 10001n, lineDiscountBp: 1250, lineDiscountFils: 1250n },
    });
  });

  it('works out per-line VAT and totals; exclusive and inclusive prices; optional lines not counted', () => {
    const lines = [
      line({ quantity: '2' }), // 2 × 100.00 + 5% = 210.00
      line({}, item({ id: '2', price: { price4dp: '1050000', includesVat: true } })), // 105.00 incl. → 100.00 + 5.00
      line({ optional: true }), // shown, not counted
    ];
    const p = preview(lines, 0n, decimals, rateOf);
    expect(p.lines[0]).toMatchObject({ netFils: 20000n, vatFils: 1000n, grossFils: 21000n });
    expect(p.lines[1]).toMatchObject({ netFils: 10000n, vatFils: 500n, grossFils: 10500n });
    expect(p.lines[2]).toMatchObject({ grossFils: 10500n });
    expect(p).toMatchObject({ netFils: 30000n, vatFils: 1500n, totalFils: 31500n, complete: true });
  });

  it('spreads the document discount over counted lines like the server', () => {
    const lines = [line({ quantity: '1' }), line({ quantity: '2' }), line({ optional: true })];
    const p = preview(lines, 1000n, decimals, rateOf);
    // 10.00 AED over 100 + 200: 3.33 and 6.67 (largest remainder); nothing on the optional line.
    expect(p.lines.map((l) => l?.discountFils)).toEqual([333n, 667n, 0n]);
    expect(p.discountFils).toBe(1000n);
    expect(p.netFils).toBe(29000n);
    // A discount larger than the lines marks the preview incomplete instead of guessing.
    expect(preview(lines, 40000n, decimals, rateOf).complete).toBe(false);
  });

  it('sends only what was changed: the price when typed, the percentage itself', () => {
    expect(toRequest([line({ quantity: '2' })], decimals)).toEqual([
      { itemId: '1', quantityMilli: '2000' },
    ]);
    expect(toRequest([line({ unitPrice: '90', discount: '5', optional: true })], decimals)).toEqual(
      [
        {
          itemId: '1',
          quantityMilli: '1000',
          unitPrice4dp: '900000',
          lineDiscountBp: 500,
          isOptional: true,
        },
      ],
    );
    expect(toRequest([line({ discountMode: 'amount', discount: '7.5' })], decimals)).toEqual([
      { itemId: '1', quantityMilli: '1000', lineDiscountFils: '750' },
    ]);
    expect(toRequest([line({ quantity: 'x' })], decimals)).toBeNull();
  });
});
