/**
 * The cash drawer's journal entries (posting map rows 16–19): every movement balances, money into
 * the drawer is a debit on the drawers account, and the accepted over/short goes to 6910.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  movementPosting,
  variancePosting,
  type DrawerMovementType,
} from '../../src/modules/ledger/cash-posting';

const DRAWER = 11n;
const REASON = 69n;
const sum = (a: { fils: bigint }[]) => a.reduce((s, x) => s + x.fils, 0n);

describe('cash posting', () => {
  it('row 18: the float and top-ups come from the safe; drops and the closing transfer go back', () => {
    expect(
      movementPosting({ type: 'opening_float', amountFils: 50_000n, drawerAccountId: DRAWER }),
    ).toEqual([
      { link: { accountId: DRAWER }, fils: 50_000n },
      { link: 'cash_in_safe', fils: -50_000n },
    ]);
    expect(
      movementPosting({ type: 'closing_transfer', amountFils: 7n, drawerAccountId: DRAWER }),
    ).toEqual([
      { link: { accountId: DRAWER }, fils: -7n },
      { link: 'cash_in_safe', fils: 7n },
    ]);
  });

  it('rows 16–17: paid-in and paid-out use the reason’s account and need it', () => {
    expect(
      movementPosting({
        type: 'paid_out',
        amountFils: 2_000n,
        drawerAccountId: DRAWER,
        reasonAccountId: REASON,
      }),
    ).toEqual([
      { link: { accountId: DRAWER }, fils: -2_000n },
      { link: { accountId: REASON }, fils: 2_000n },
    ]);
    expect(() =>
      movementPosting({ type: 'paid_in', amountFils: 1n, drawerAccountId: DRAWER }),
    ).toThrow();
  });

  it('row 19: short is a debit on over/short, over a credit', () => {
    expect(variancePosting(-1_000n, DRAWER)).toEqual([
      { link: { accountId: DRAWER }, fils: -1_000n },
      { link: 'cash_over_short', fils: 1_000n },
    ]);
    expect(variancePosting(5n, DRAWER)[1]).toEqual({ link: 'cash_over_short', fils: -5n });
  });

  it('every entry balances', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<DrawerMovementType>(
          'opening_float',
          'paid_in',
          'paid_out',
          'cash_drop',
          'float_top_up',
          'closing_transfer',
        ),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (type, amountFils) => {
          expect(
            sum(
              movementPosting({
                type,
                amountFils,
                drawerAccountId: DRAWER,
                reasonAccountId: REASON,
              }),
            ),
          ).toBe(0n);
          expect(sum(variancePosting(amountFils, DRAWER))).toBe(0n);
        },
      ),
    );
  });
});
