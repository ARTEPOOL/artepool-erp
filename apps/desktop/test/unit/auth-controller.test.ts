/** T9: the sign-in flow's rules that are about time and server answers, without screens. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../../src/features/auth/controller';
import {
  failure,
  FakeBridge,
  ok,
  sessionView,
  signInAnswer,
  userView,
} from '../support/fake-bridge';

const me = (idleTimeoutSeconds = 300) =>
  ok({
    session: sessionView({ idleTimeoutSeconds }),
    user: userView(),
    device: { id: '2', code: 'OFFICE-01', name: 'Owner office', kind: 'office' },
    permissions: [],
  });

async function signedIn(bridge: FakeBridge) {
  const controller = new AuthController(bridge);
  await controller.start();
  await controller.signInWithPassword('sara.office', 'blue-pool-water');
  expect(controller.getState().phase.name).toBe('app');
  return controller;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('idle lock (POS 5 minutes, office 15)', () => {
  it('locks after the idle time without activity; activity postpones it', async () => {
    const bridge = new FakeBridge()
      .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer()))
      .on('GET', '/api/v1/auth/me', me(300));
    const controller = await signedIn(bridge);
    const target = new EventTarget() as unknown as Window;
    const stop = controller.watchIdle(target);

    await vi.advanceTimersByTimeAsync(240_000);
    target.dispatchEvent(new Event('keydown'));
    await vi.advanceTimersByTimeAsync(240_000);
    expect(controller.getState().phase.name).toBe('app');

    await vi.advanceTimersByTimeAsync(65_000);
    expect(controller.getState().phase.name).toBe('locked');
    // The server is told with a background call, so it records the idle lock itself.
    expect(bridge.callsTo('GET', '/api/v1/auth/me').at(-1)?.background).toBe(true);
    stop();
  });

  it('passes activity on to the server at most once a minute', async () => {
    const bridge = new FakeBridge()
      .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer()))
      .on('GET', '/api/v1/auth/me', me(900));
    const controller = await signedIn(bridge);
    const target = new EventTarget() as unknown as Window;
    const stop = controller.watchIdle(target);
    const before = bridge.callsTo('GET', '/api/v1/auth/me').length;

    for (let i = 0; i < 10; i++) {
      target.dispatchEvent(new Event('pointerdown'));
      await vi.advanceTimersByTimeAsync(10_000);
    }
    const heartbeats = bridge.callsTo('GET', '/api/v1/auth/me').slice(before);
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]?.background).toBeUndefined();
    stop();
  });
});

describe('answers that change the screen', () => {
  it('a revoked PC goes to enrollment and forgets the session', async () => {
    const bridge = new FakeBridge()
      .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer()))
      .on('GET', '/api/v1/auth/me', me(), failure(403, 'DEVICE_REVOKED'));
    const controller = await signedIn(bridge);
    await controller.api.get('/api/v1/auth/me').catch(() => undefined);
    expect(controller.getState()).toMatchObject({
      phase: { name: 'enroll', notice: 'revoked' },
      session: null,
      user: null,
    });
    await controller.api.get('/api/v1/auth/me').catch(() => undefined);
    expect(bridge.calls.at(-1)?.token).toBeUndefined();
  });

  it('an outdated app is told the minimum version', async () => {
    const bridge = new FakeBridge().on(
      'GET',
      '/api/v1/devices/me',
      failure(426, 'CLIENT_OUTDATED', { minVersion: '0.2.0' }),
    );
    const controller = new AuthController(bridge);
    await controller.start();
    expect(controller.getState().phase).toEqual({ name: 'outdated', minVersion: '0.2.0' });
  });

  it('a locked session shows the lock screen', async () => {
    const bridge = new FakeBridge()
      .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer()))
      .on('GET', '/api/v1/auth/me', me(), failure(423, 'SESSION_LOCKED'));
    const controller = await signedIn(bridge);
    await controller.api.get('/api/v1/auth/me').catch(() => undefined);
    expect(controller.getState().phase.name).toBe('locked');
  });

  it('the temporary password is kept for the "choose your own" step for 10 minutes only', async () => {
    const bridge = new FakeBridge().on(
      'POST',
      '/api/v1/auth/sign-in',
      ok(signInAnswer({ pending: 'credential_change' })),
    );
    const controller = new AuthController(bridge);
    await controller.start();
    await controller.signInWithPassword('sara.office', 'ABCD-EFGH-JKLM');
    expect(controller.getState().phase).toEqual({
      name: 'changeCredential',
      credential: 'password',
    });
    expect(controller.hasPendingSecret).toBe(true);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(controller.hasPendingSecret).toBe(false);
  });
});
