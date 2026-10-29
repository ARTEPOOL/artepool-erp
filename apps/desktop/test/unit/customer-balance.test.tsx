/**
 * The customer's balance banner and the customers list's cell (decision 0114): the colour by
 * status, the words for everyone, the amounts only when the server sent them, a cash customer only
 * when they owe, never the walk-in; Arabic right to left.
 */
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { CustomerBalance } from '@artepool/shared/contracts';
import { initI18n } from '../../src/i18n';
import { BalanceBanner, BalanceCell } from '../../src/features/sales/CustomerBalanceBanner';

afterEach(cleanup);

const amounts = (
  outstanding: string,
  limit: string,
  extra: Partial<Record<string, string>> = {},
) => ({
  outstandingFils: outstanding,
  overdueFils: '0',
  creditLimitFils: limit,
  availableFils: (BigInt(limit) - BigInt(outstanding)).toString(),
  advancesFils: '0',
  netPositionFils: outstanding,
  ...extra,
});

const credit = (
  status: CustomerBalance['status'],
  a: CustomerBalance['amounts'],
): CustomerBalance => ({
  status,
  creditMode: 'credit',
  isWalkIn: false,
  amounts: a,
});

const banner = () => screen.getByRole('status', { name: /Customer balance|رصيد العميل/ });

describe('the balance banner (decision 0114)', () => {
  it('green, yellow, orange and red by status', async () => {
    await initI18n('en');
    const cases: [CustomerBalance, string, string][] = [
      [credit('nothing_due', amounts('0', '100000')), 'green', 'Nothing due'],
      [credit('within_limit', amounts('30000', '100000')), 'yellow', 'Within limit'],
      [credit('near_limit', amounts('85000', '100000')), 'orange', 'Near the credit limit'],
      [
        credit('overdue', amounts('30000', '100000', { overdueFils: '20000' })),
        'orange',
        'Has overdue invoices',
      ],
      [credit('over_limit', amounts('120000', '100000')), 'red', 'Over limit — approval needed'],
    ];
    for (const [balance, colour, words] of cases) {
      const { unmount } = render(<BalanceBanner balance={balance} />);
      expect(banner().className).toContain(colour);
      expect(banner().dataset.status).toBe(balance.status);
      expect(within(banner()).getByText(words)).toBeTruthy();
      unmount();
    }
  });

  it('the owner and accountant see the amounts; overdue and advances only when there are any', async () => {
    await initI18n('en');
    render(
      <BalanceBanner
        balance={credit(
          'overdue',
          amounts('360000', '1000000', { overdueFils: '50000', advancesFils: '31500' }),
        )}
      />,
    );
    const b = within(banner());
    expect(b.getByText('Outstanding: AED 3,600.00')).toBeTruthy();
    expect(b.getByText('Overdue: AED 500.00')).toBeTruthy();
    expect(b.getByText('Credit limit: AED 10,000.00')).toBeTruthy();
    expect(b.getByText('Available: AED 6,400.00')).toBeTruthy();
    // Advance payments apart: never subtracted from what is owed.
    expect(b.getByText('Advance payments: AED 315.00')).toBeTruthy();
    cleanup();
    render(<BalanceBanner balance={credit('within_limit', amounts('30000', '100000'))} />);
    expect(within(banner()).queryByText(/Overdue:/)).toBeNull();
    expect(within(banner()).queryByText(/Advance payments/)).toBeNull();
  });

  it('the cashier sees the colour and the words, never an amount', async () => {
    await initI18n('en');
    render(<BalanceBanner balance={credit('over_limit', null)} />);
    expect(banner().className).toContain('red');
    expect(banner().textContent).toBe('Over limit — approval needed');
    expect(banner().textContent).not.toMatch(/\d/);
  });

  it('a cash customer only when they owe (then red); the walk-in never', async () => {
    await initI18n('en');
    const cash = (status: CustomerBalance['status'], isWalkIn = false): CustomerBalance => ({
      status,
      creditMode: 'cash',
      isWalkIn,
      amounts: null,
    });
    const { container, rerender } = render(<BalanceBanner balance={cash('nothing_due')} />);
    expect(container.textContent).toBe('');
    rerender(<BalanceBanner balance={cash('over_limit')} />);
    expect(banner().className).toContain('red');
    expect(within(banner()).getByText('Cash customer who owes — approval needed')).toBeTruthy();
    rerender(<BalanceBanner balance={cash('over_limit', true)} />);
    expect(container.textContent).toBe('');
    // A credit customer with nothing due still shows (green).
    rerender(<BalanceBanner balance={credit('nothing_due', null)} />);
    expect(banner().className).toContain('green');
  });

  it('in Arabic, right to left, with the amounts in dirhams', async () => {
    await initI18n('ar');
    render(
      <BalanceBanner
        balance={credit('overdue', amounts('360000', '1000000', { overdueFils: '50000' }))}
      />,
    );
    const b = within(banner());
    expect(b.getByText('عليه فواتير متأخرة')).toBeTruthy();
    expect(b.getByText('المستحق: 3,600.00 درهم')).toBeTruthy();
    expect(b.getByText('المتأخر: 500.00 درهم')).toBeTruthy();
    expect(b.getByText('المتاح: 6,400.00 درهم')).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    await initI18n('en');
  });
});

describe('the customers list cell (decision 0114)', () => {
  it('the amount with its colour, the words without the permission, a dash when nothing is due', async () => {
    await initI18n('en');
    const { container, rerender } = render(
      <BalanceCell
        balance={{ status: 'overdue', outstandingFils: '50000', overdueFils: '20000' }}
        creditMode="credit"
      />,
    );
    const cell = container.querySelector('[data-status]')!;
    expect(cell.textContent).toBe('500.00');
    expect(cell.className).toContain('orange');
    rerender(
      <BalanceCell
        balance={{ status: 'over_limit', outstandingFils: null, overdueFils: null }}
        creditMode="cash"
      />,
    );
    expect(container.textContent).toBe('Cash customer who owes — approval needed');
    rerender(
      <BalanceCell
        balance={{ status: 'nothing_due', outstandingFils: '0', overdueFils: '0' }}
        creditMode="credit"
      />,
    );
    expect(container.textContent).toBe('—');
  });
});
