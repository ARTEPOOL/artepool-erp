/**
 * The office PCs' app updater (decision 0108): a newer signed version installs at once while
 * nobody is signed in; while someone works it waits for "Install and restart"; nothing is shown
 * when there is no update.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppUpdater } from '../../src/features/updates/AppUpdater';

const bridge = vi.hoisted(() => ({
  checkAppUpdate: vi.fn(),
  installAppUpdate: vi.fn(),
}));
vi.mock('../../src/features/updates/bridge', () => bridge);
const auth = vi.hoisted((): { phase: { name: string } } => ({ phase: { name: 'signIn' } }));
vi.mock('../../src/features/auth/context', () => ({ useAuthState: () => auth }));

const update = { version: '1.1.0', notesAr: 'الكاشير بقى أسرع.', notesEn: 'The POS is faster.' };

beforeEach(() => {
  bridge.checkAppUpdate.mockReset();
  bridge.installAppUpdate.mockReset().mockResolvedValue(undefined);
});

describe('the app updater', () => {
  it('shows nothing without an update', async () => {
    bridge.checkAppUpdate.mockResolvedValue(null);
    render(<AppUpdater />);
    await waitFor(() => expect(bridge.checkAppUpdate).toHaveBeenCalled());
    expect(screen.queryByTestId('app-update')).toBeNull();
    expect(bridge.installAppUpdate).not.toHaveBeenCalled();
  });

  it('installs at once on the sign-in screen', async () => {
    auth.phase = { name: 'signIn' };
    bridge.checkAppUpdate.mockResolvedValue(update);
    render(<AppUpdater />);
    await waitFor(() => expect(bridge.installAppUpdate).toHaveBeenCalledTimes(1));
  });

  it('while someone works, waits for "Install and restart" and shows the notes', async () => {
    auth.phase = { name: 'signedIn' };
    bridge.checkAppUpdate.mockResolvedValue(update);
    render(<AppUpdater />);
    expect(await screen.findByText('الكاشير بقى أسرع.')).toBeTruthy();
    expect(bridge.installAppUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /سطّب وأعد التشغيل/ }));
    await waitFor(() => expect(bridge.installAppUpdate).toHaveBeenCalledTimes(1));
  });
});
