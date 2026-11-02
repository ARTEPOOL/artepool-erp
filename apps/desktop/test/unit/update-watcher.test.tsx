/**
 * "Updating ARTEPOOL" on every PC (decision 0115, 0.9.0): a request refused with "UPDATING" brings
 * up the screen; it follows the status page's steps; when the page has closed it says the server
 * is starting; when the server answers again it says whether the update worked, by the server's
 * version. A failed update: the previous version runs, the data is as it was, and the owner is
 * told where the reason is. In Arabic and in English.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResponse, UpdateStepRecord } from '@artepool/shared/contracts';
import { ApiError } from '../../src/api/client';
import { initI18n } from '../../src/i18n';
import { HEALTH_EVERY_MS, UpdateWatcher } from '../../src/features/updates/UpdateWatcher';

const api = vi.hoisted(() => ({
  listeners: new Set<(error: unknown) => void>(),
  answers: [] as BridgeResponse[],
  probes: [] as string[],
}));
const fakeApi = {
  onError: (listener: (error: unknown) => void) => {
    api.listeners.add(listener);
    return () => api.listeners.delete(listener);
  },
  probe: (path: string) => {
    api.probes.push(path);
    const unreachable: BridgeResponse = { kind: 'unreachable' };
    return Promise.resolve(api.answers.shift() ?? unreachable);
  },
};
vi.mock('../../src/api/hooks', () => ({ useApi: () => fakeApi }));
const permissions = vi.hoisted(() => new Set<string>());
vi.mock('../../src/features/auth/context', () => ({
  useCan: () => (permission: string) => permissions.has(permission),
}));

const at = (s: number) => new Date(Date.UTC(2026, 10, 5, 23, 0, s)).toISOString();
const steps = (running: number): UpdateStepRecord[] =>
  (['prepare', 'stop', 'backup', 'database', 'start'] as const).map((step, i) => ({
    step,
    state: i < running ? 'done' : i === running ? 'running' : 'pending',
    startedAt: i <= running ? at(i * 10) : null,
    endedAt: i < running ? at(i * 10 + 10) : null,
  }));
const page = (running: number): BridgeResponse => ({
  kind: 'response',
  status: 503,
  contentType: 'application/json',
  body: {
    status: 'updating',
    update: { from: '0.9.0', to: '0.9.1', startedAt: at(0), steps: steps(running), result: null },
  },
});
const healthy: BridgeResponse = {
  kind: 'response',
  status: 200,
  contentType: 'application/json',
  body: { status: 'ok', database: 'up' },
};
const version = (v: string): BridgeResponse => ({
  kind: 'response',
  status: 200,
  contentType: 'application/json',
  body: { version: v },
});

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <UpdateWatcher />
    </QueryClientProvider>,
  );
}

/** The next look at /health, a few seconds later. */
async function next() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HEALTH_EVERY_MS);
  });
}

async function refused() {
  await act(async () => {
    api.listeners.forEach((listener) => listener(new ApiError('UPDATING', 503)));
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(async () => {
  // Only the watcher's repeat timer: the test library's own waits keep real time.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  api.answers = [];
  api.probes = [];
  permissions.clear();
  await initI18n('ar');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('"Updating ARTEPOOL" (0115)', () => {
  it('nothing until a request is refused because the server is being updated', async () => {
    show();
    await act(async () => {
      api.listeners.forEach((listener) => listener(new ApiError('SERVER_UNREACHABLE', 0)));
      await vi.advanceTimersByTimeAsync(HEALTH_EVERY_MS * 2);
    });
    expect(screen.queryByTestId('server-updating')).toBeNull();
    expect(api.probes).toEqual([]);
  });

  it('follows the steps, the server starting, then says it is updated', async () => {
    api.answers = [page(2), page(3), { kind: 'unreachable' }, healthy, version('0.9.1')];
    show();
    await refused();
    const screenEl = await screen.findByTestId('server-updating');
    expect(within(screenEl).getByText('جاري تحديث آرتيبول')).toBeTruthy();
    expect(within(screenEl).getByText('من 0.9.0 لـ 0.9.1')).toBeTruthy();
    const labels = () =>
      within(screen.getByTestId('update-steps'))
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-label'));
    expect(labels()).toEqual([
      'تجهيز: خلصت',
      'إيقاف البرنامج: خلصت',
      'نسخة احتياطية: شغالة دلوقتي',
      'تحديث قاعدة البيانات: لسه',
      'تشغيل: لسه',
    ]);
    await next();
    expect(labels()[3]).toBe('تحديث قاعدة البيانات: شغالة دلوقتي');
    // The status page has closed: the new server is starting.
    await next();
    expect(screen.getByText('السيرفر بيشتغل دلوقتي…')).toBeTruthy();
    expect(labels()[4]).toBe('تشغيل: شغالة دلوقتي');
    // It answers again, with the new version.
    await next();
    expect(screen.queryByTestId('server-updating')).toBeNull();
    const done = await screen.findByTestId('server-update-done');
    expect(done.dataset.outcome).toBe('ok');
    expect(within(done).getByText('آرتيبول بقى على النسخة 0.9.1.')).toBeTruthy();
    expect(api.probes).toEqual([
      '/health',
      '/health',
      '/health',
      '/health',
      '/api/v1/system/version',
    ]);
    fireEvent.click(within(done).getByRole('button', { name: 'تمام' }));
    expect(screen.queryByTestId('server-update-done')).toBeNull();
  });

  it('the previous version back: the update did not succeed, the data is as it was', async () => {
    permissions.add('system.health.view');
    api.answers = [page(3), { kind: 'unreachable' }, healthy, version('0.9.0')];
    show();
    await refused();
    await next();
    await next();
    const done = await screen.findByTestId('server-update-done');
    expect(done.dataset.outcome).toBe('failed');
    expect(
      within(done).getByText('النسخة القديمة 0.9.0 رجعت وشغالة، وبياناتك زي ما هي.'),
    ).toBeTruthy();
    // The owner is told where the reason is.
    expect(within(done).getByText('السبب مكتوب في الإعدادات ← صحة النظام.')).toBeTruthy();
  });

  it('in English, left to right', async () => {
    await initI18n('en');
    api.answers = [page(1), healthy, version('0.9.1')];
    show();
    await refused();
    expect(await screen.findByText('Updating ARTEPOOL')).toBeTruthy();
    expect(screen.getByText('From 0.9.0 to 0.9.1')).toBeTruthy();
    expect(screen.getByText('Do not turn off the server PC.', { exact: false })).toBeTruthy();
    await next();
    expect(await screen.findByText('ARTEPOOL is now on version 0.9.1.')).toBeTruthy();
    expect(document.documentElement.dir).toBe('ltr');
  });
});
