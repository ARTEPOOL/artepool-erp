/**
 * M3-T10: stock alerts on the dashboard, against a scripted server. A tile shows only when its
 * count is above zero and the person may see it; each one leads to where the work is done.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StockSummary } from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { FakeBridge, ok, sessionView, signInAnswer, userView } from '../support/fake-bridge';

function bridgeWith(summary: StockSummary, permissions: string[]) {
  return new FakeBridge()
    .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer({}, { displayNameAr: 'محمد ياسر' })))
    .on(
      'GET',
      '/api/v1/auth/me',
      ok({
        session: sessionView(),
        user: userView({ displayNameAr: 'محمد ياسر', displayNameEn: 'Mohammed Yasser' }),
        device: { id: '2', code: 'OFFICE-01', name: 'Owner office', kind: 'office' },
        permissions,
      }),
    )
    .on('GET', '/api/v1/stock/summary', ok(summary))
    .on('GET', '/api/v1/items', ok({ items: [], total: 0 }))
    .on('GET', '/api/v1/adjustments', ok({ adjustments: [], total: 0 }));
}

async function signIn(bridge: FakeBridge) {
  render(<App bridge={bridge} />);
  await screen.findByRole('heading', { level: 1 });
  fireEvent.change(screen.getByLabelText('اسم المستخدم'), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText('كلمة المرور'), { target: { value: 'blue-pool-water' } });
  fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
  await screen.findByRole('heading', { name: 'أهلًا، محمد ياسر' });
}

const ALL: StockSummary = { toReorder: 4, defectiveItems: 2, pendingReviews: 1 };

describe('Dashboard → stock alerts', () => {
  it('shows each alert with its count to a storekeeper who reviews oversells', async () => {
    await signIn(bridgeWith(ALL, ['items.view', 'stock.oversell_review']));
    const reorder = await screen.findByTestId('stock-alert-toReorder');
    expect(reorder.textContent).toContain('أصناف تحتاج إعادة طلب');
    expect(reorder.textContent).toContain('4');
    expect(screen.getByTestId('stock-alert-defective').textContent).toContain('2');
    const reviews = screen.getByTestId('stock-alert-reviews');
    expect(reviews.textContent).toContain('بيع أكثر من المتوفر بانتظار المراجعة');
    expect(reviews.getAttribute('href')).toBe('/stock/reviews');
    expect(reorder.getAttribute('href')).toBe('/items');
    // The rest of the dashboard stays.
    expect(screen.getByText(/تأتي لوحة التحكم مع المبيعات/)).toBeTruthy();
  });

  it('hides the alerts whose count is zero', async () => {
    await signIn(
      bridgeWith({ toReorder: 0, defectiveItems: 3, pendingReviews: 0 }, [
        'items.view',
        'stock.oversell_review',
      ]),
    );
    expect(await screen.findByTestId('stock-alert-defective')).toBeTruthy();
    expect(screen.queryByTestId('stock-alert-toReorder')).toBeNull();
    expect(screen.queryByTestId('stock-alert-reviews')).toBeNull();
  });

  it('pending reviews need stock.oversell_review', async () => {
    await signIn(bridgeWith(ALL, ['items.view']));
    expect(await screen.findByTestId('stock-alert-toReorder')).toBeTruthy();
    expect(screen.queryByTestId('stock-alert-reviews')).toBeNull();
  });

  it('nothing without items.view, and the summary is not asked for', async () => {
    const bridge = bridgeWith(ALL, ['stock.oversell_review']);
    await signIn(bridge);
    expect(screen.queryByRole('region', { name: 'تنبيهات المخزون' })).toBeNull();
    expect(screen.queryByTestId('stock-alert-reviews')).toBeNull();
    expect(bridge.callsTo('GET', '/api/v1/stock/summary')).toHaveLength(0);
  });

  it('an alert opens its page', async () => {
    await signIn(bridgeWith(ALL, ['items.view', 'stock.oversell_review']));
    fireEvent.click(await screen.findByTestId('stock-alert-reviews'));
    await waitFor(() => expect(screen.queryByTestId('stock-alert-reviews')).toBeNull());
    expect(screen.queryByRole('heading', { name: 'أهلًا، محمد ياسر' })).toBeNull();
  });
});
