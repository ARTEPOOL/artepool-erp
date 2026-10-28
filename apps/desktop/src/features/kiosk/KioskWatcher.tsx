/**
 * On a POS PC: keeps the kiosk lock up to date, shows "Kiosk lock is off" (until … / while the
 * owner is signed in) while it is off, and reports a refused close to the server, which audits it
 * and alerts the owner (decisions 0082, 0089, 0091).
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LockOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useApi } from '../../api/hooks';
import { formatTime } from '../../lib/format';
import { iconClass } from '../../ui';
import { useAuthState } from '../auth/context';
import styles from './kiosk.module.css';
import { KIOSK_KEY, useKiosk } from './state';

export function KioskWatcher() {
  const { t } = useTranslation('auth');
  const api = useApi();
  const kiosk = useKiosk();
  const queryClient = useQueryClient();
  const { phase, user } = useAuthState();

  // Signing in, locking the screen or signing out can change the lock (the owner, 0091): ask now.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: KIOSK_KEY });
  }, [queryClient, phase.name, user?.id]);

  useEffect(() => {
    if (!isTauri()) return;
    const stop = listen('kiosk-close-refused', () => {
      void api
        .post('/api/v1/kiosk/events', { kind: 'close_refused' }, { background: true })
        .catch(() => undefined);
    });
    return () => void stop.then((unlisten) => unlisten());
  }, [api]);

  // The bar's room at the top of the window (tokens-app.css: --kiosk-bar-height).
  const off = !!kiosk?.isPos && !kiosk.locked;
  useEffect(() => {
    const root = document.documentElement;
    if (off) root.dataset.kioskOff = '';
    else delete root.dataset.kioskOff;
    return () => void delete root.dataset.kioskOff;
  }, [off]);

  if (!off || !kiosk) return null;
  return (
    <div className={styles.banner} role="status" data-testid="kiosk-off">
      <LockOpen className={iconClass.sm} aria-hidden="true" />
      <span>
        {t('kiosk.off')}
        {kiosk.switchedOff && kiosk.offUntil && (
          <> · {t('kiosk.until', { time: formatTime(kiosk.offUntil) })}</>
        )}
        {!kiosk.switchedOff && kiosk.ownerSignedIn && <> · {t('kiosk.ownerIn')}</>}
      </span>
    </div>
  );
}
