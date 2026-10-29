/** Decision 0114: the balance status and when the banner shows. */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { balanceStatus, showsBalanceBanner } from '../src/balance/index';

const status = (outstanding: bigint, overdue: bigint, limit: bigint) =>
  balanceStatus({ outstandingFils: outstanding, overdueFils: overdue, creditLimitFils: limit });

describe('the balance status', () => {
  it('green, yellow, orange (80% or overdue), red (over the limit)', () => {
    expect(status(0n, 0n, 1_000_000n)).toBe('nothing_due');
    expect(status(-5000n, 0n, 1_000_000n)).toBe('nothing_due'); // the customer is owed money
    expect(status(500_000n, 0n, 1_000_000n)).toBe('within_limit');
    expect(status(799_999n, 0n, 1_000_000n)).toBe('within_limit');
    expect(status(800_000n, 0n, 1_000_000n)).toBe('near_limit');
    expect(status(1_000_000n, 0n, 1_000_000n)).toBe('near_limit'); // at the limit, not over
    expect(status(100_000n, 100n, 1_000_000n)).toBe('overdue');
    expect(status(1_000_001n, 0n, 1_000_000n)).toBe('over_limit');
    expect(status(1_000_001n, 50n, 1_000_000n)).toBe('over_limit'); // red wins over orange
  });

  it('a cash customer who owes anything is over the limit (0046)', () => {
    expect(status(1n, 0n, 0n)).toBe('over_limit');
    expect(status(0n, 0n, 0n)).toBe('nothing_due');
  });

  it('over the limit exactly when the credit rule would ask for approval', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -10_000_000n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        (outstanding, overdue, limit) =>
          (status(outstanding, overdue, limit) === 'over_limit') ===
          (outstanding > 0n && outstanding > limit),
      ),
    );
  });
});

describe('when the banner shows', () => {
  it('never for the walk-in; a cash customer only when they owe; a credit customer always', () => {
    expect(showsBalanceBanner({ isWalkIn: true, creditMode: 'cash', status: 'over_limit' })).toBe(
      false,
    );
    expect(showsBalanceBanner({ isWalkIn: false, creditMode: 'cash', status: 'nothing_due' })).toBe(
      false,
    );
    expect(showsBalanceBanner({ isWalkIn: false, creditMode: 'cash', status: 'over_limit' })).toBe(
      true,
    );
    expect(
      showsBalanceBanner({ isWalkIn: false, creditMode: 'credit', status: 'nothing_due' }),
    ).toBe(true);
  });
});
