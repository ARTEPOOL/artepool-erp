/** Posting map rows 12–15 and 21: which accounts a stock document debits and credits. */
import { describe, expect, it } from 'vitest';
import { stockPosting } from '../../src/modules/ledger/stock-posting';

const net = (amounts: { fils: bigint }[]) => amounts.reduce((s, a) => s + a.fils, 0n);
const sides = (amounts: { link: string | { accountId: bigint }; fils: bigint }[]) =>
  Object.fromEntries(
    amounts
      .filter((a) => a.fils !== 0n)
      .map((a) => [typeof a.link === 'string' ? a.link : `#${a.link.accountId}`, a.fils]),
  );

describe('stock postings', () => {
  it('row 21 — opening stock: Inventory / Opening balance equity', () => {
    const a = stockPosting('opening', [{ stockStatus: 'available', valueFils: 1235n }]);
    expect(sides(a)).toEqual({ inventory: 1235n, opening_balance_equity: -1235n });
    expect(net(a)).toBe(0n);
  });

  it('row 13 — more found: Inventory / Inventory adjustments; less found: the reverse', () => {
    expect(
      sides(stockPosting('increase', [{ stockStatus: 'available', valueFils: 500n }])),
    ).toEqual({
      inventory: 500n,
      stock_adjustments: -500n,
    });
    expect(
      sides(stockPosting('decrease', [{ stockStatus: 'available', valueFils: -371n }])),
    ).toEqual({
      inventory: -371n,
      stock_adjustments: 371n,
    });
    expect(
      sides(
        stockPosting('count', [
          { stockStatus: 'available', valueFils: 200n },
          { stockStatus: 'available', valueFils: -50n },
        ]),
      ),
    ).toEqual({ inventory: 150n, stock_adjustments: -150n });
  });

  it('row 12 — oversell: Inventory / Inventory adjustments', () => {
    expect(
      sides(stockPosting('oversell', [{ stockStatus: 'available', valueFils: 600n }])),
    ).toEqual({
      inventory: 600n,
      stock_adjustments: -600n,
    });
  });

  it('row 14 — to defective: Inventory – defective / Inventory, the same value', () => {
    const a = stockPosting('status_change', [
      { stockStatus: 'available', valueFils: -250n },
      { stockStatus: 'defective', valueFils: 250n },
    ]);
    expect(sides(a)).toEqual({ inventory: -250n, inventory_defective: 250n });
  });

  it('row 14 — a 1-fils rounding difference between the two stocks goes to adjustments', () => {
    const a = stockPosting('status_change', [
      { stockStatus: 'available', valueFils: -371n },
      { stockStatus: 'defective', valueFils: 370n },
    ]);
    expect(sides(a)).toEqual({
      inventory: -371n,
      inventory_defective: 370n,
      stock_adjustments: 1n,
    });
    expect(net(a)).toBe(0n);
  });

  it('row 15 — write-off: Defective write-offs / Inventory – defective', () => {
    expect(
      sides(stockPosting('write_off', [{ stockStatus: 'defective', valueFils: -250n }])),
    ).toEqual({
      inventory_defective: -250n,
      write_off: 250n,
    });
  });
});
