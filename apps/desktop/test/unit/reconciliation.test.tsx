/**
 * The reconciliation report (M7, decision 0119) against a scripted server: the period sent, the
 * seven steps green or red with their checks, problems and figures, the PDF for the accountant,
 * Arabic right to left, and a note instead of the report for those without the permission.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReconciliationReport } from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { setLanguage } from '../../src/i18n';
import { dubaiDay } from '../../src/lib/format';
import { FakeBridge, ok, sessionView, signInAnswer, userView } from '../support/fake-bridge';

const start = vi.hoisted(() => ({ path: '/' }));
vi.mock('../../src/app/router', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/app/router')>();
  return { ...original, createAppRouter: () => original.createAppRouter(start.path) };
});

const printed = vi.hoisted(() => ({ files: [] as unknown[] }));
vi.mock('../../src/features/sales/print', () => ({
  printPdf: (file: unknown) => {
    printed.files.push(file);
    return Promise.resolve();
  },
}));

const TODAY = dubaiDay();
const passed = (name: string) => ({ name, ok: true, problems: 0, examples: [] });

const REPORT: ReconciliationReport = {
  id: '41',
  from: TODAY,
  to: TODAY,
  ranAt: `${TODAY}T10:00:00.000Z`,
  ok: false,
  steps: [
    {
      step: 'stock',
      ok: true,
      checks: [passed('stock_vs_ledger'), passed('oversells_reviewed')],
      figures: [
        { key: 'movements', kind: 'count', value: '32' },
        { key: 'stockValue', kind: 'fils', value: '37000' },
      ],
    },
    {
      step: 'cash',
      ok: false,
      checks: [
        passed('cash_shifts'),
        {
          name: 'variances_accepted',
          ok: false,
          problems: 7,
          examples: ['shift Z-000009: variance not accepted yet'],
        },
      ],
      figures: [{ key: 'variance', kind: 'fils', value: '-15000' }],
    },
    {
      step: 'invoices',
      ok: true,
      checks: [passed('numbering_gaps')],
      figures: [{ key: 'series:POS', kind: 'text', value: 'POS-000001 … POS-000012 (12)' }],
    },
    { step: 'vat', ok: true, checks: [passed('vat_ledger')], figures: [] },
    { step: 'accounts', ok: true, checks: [passed('trial_balance')], figures: [] },
    { step: 'audit', ok: true, checks: [passed('audit_chain')], figures: [] },
    {
      step: 'backup',
      ok: true,
      checks: [passed('restore_test')],
      figures: [{ key: 'lastRestoreResult', kind: 'text', value: 'ok' }],
    },
  ],
};

function bridgeFor(permissions: string[]) {
  start.path = '/reconciliation';
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
    .on('POST', '/api/v1/reports/reconciliation', ok(REPORT))
    .on(
      'GET',
      '/api/v1/reports/reconciliation/41/pdf',
      ok({ fileName: 'reconciliation.pdf', mime: 'application/pdf', dataBase64: 'JVBERi0=' }),
    );
}

async function signIn(bridge: FakeBridge, heading: string, language: 'ar' | 'en') {
  await act(() => setLanguage(language));
  render(<App bridge={bridge} />);
  const labels =
    language === 'en'
      ? { user: 'Username', password: 'Password', go: 'Sign in' }
      : { user: 'اسم المستخدم', password: 'كلمة المرور', go: 'دخول' };
  fireEvent.change(await screen.findByLabelText(labels.user), { target: { value: 'mohammed' } });
  fireEvent.change(screen.getByLabelText(labels.password), {
    target: { value: 'blue-pool-water' },
  });
  fireEvent.click(screen.getByRole('button', { name: labels.go }));
  await screen.findByRole('heading', { name: heading, level: 1 });
}

describe('the reconciliation report (decision 0119)', () => {
  it('runs for the period and shows the seven steps, the red one with its problems', async () => {
    const bridge = bridgeFor(['reports.reconciliation', 'stock.view_cost']);
    await signIn(bridge, 'Reconciliation report', 'en');
    fireEvent.click(screen.getByRole('button', { name: 'Run the reconciliation' }));
    const report = await screen.findByTestId('reconciliation');
    expect(bridge.callsTo('POST', '/api/v1/reports/reconciliation')[0]!.body).toEqual({
      from: TODAY,
      to: TODAY,
    });
    expect(within(report).getByText(/Something does not match/)).toBeTruthy();
    for (const title of [
      '1. Stock',
      '2. Cash and shifts',
      '3. Invoices and numbering',
      '4. VAT',
      '5. Accounts',
      '6. Audit log',
      '7. Backup',
    ])
      expect(within(report).getByRole('heading', { name: title })).toBeTruthy();

    const cash = screen.getByTestId('step-cash');
    expect(cash.dataset.ok).toBe('false');
    expect(within(cash).getByText('Problem')).toBeTruthy();
    expect(within(cash).getByText('Every shift variance in the period accepted')).toBeTruthy();
    expect(within(cash).getByText('shift Z-000009: variance not accepted yet')).toBeTruthy();
    expect(within(cash).getByText('+6 more')).toBeTruthy();
    expect(within(cash).getByText('-150.00 AED')).toBeTruthy();

    const stock = screen.getByTestId('step-stock');
    expect(within(stock).getByText('Matches')).toBeTruthy();
    expect(within(stock).getByText('370.00 AED')).toBeTruthy();
    expect(within(screen.getByTestId('step-invoices')).getByText('Series POS')).toBeTruthy();
    expect(within(screen.getByTestId('step-backup')).getByText('Passed')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Print / PDF' }));
    await vi.waitFor(() => expect(printed.files).toHaveLength(1));
  });

  it('in Arabic, right to left', async () => {
    await signIn(bridgeFor(['reports.reconciliation']), 'تقرير المطابقة', 'ar');
    expect(document.documentElement.dir).toBe('rtl');
    fireEvent.click(screen.getByRole('button', { name: 'شغّل المطابقة' }));
    const cash = await screen.findByTestId('step-cash');
    expect(within(cash).getByRole('heading', { name: '2. الكاش والورديات' })).toBeTruthy();
    expect(within(cash).getByText('توجد مشكلة')).toBeTruthy();
    expect(within(screen.getByTestId('step-stock')).getByText('مطابق')).toBeTruthy();
  });

  it('without the permission: a note, and no request', async () => {
    const bridge = bridgeFor([]);
    await act(() => setLanguage('en'));
    render(<App bridge={bridge} />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'sara' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'blue-pool-water' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText('The reconciliation report is for the owner and the accountant.'),
    ).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/reports/reconciliation')).toHaveLength(0);
  });
});
