/**
 * On a POS PC: keeps the kiosk lock up to date, shows "Kiosk lock is off" (until …) while the
 * owner has turned it off, and reports a refused close to the server, which audits it and alerts
 * the owner (decisions 0082, 0089).
 */
import { useEffect } from 'react';
import { LockOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useApi } from '../../api/hooks';
import { formatTime } from '../../lib/format';
import { iconClass } from '../../ui';
import styles from './kiosk.module.css';
import { useKiosk } from './state';

export function KioskWatcher() {
  const { t } = useTranslation('auth');
  const api = useApi();
  const kiosk = useKiosk();

  useEffect(() => {
    if (!isTauri()) return;
    const stop = listen('kiosk-close-refused', () => {
      void api
        .post('/api/v1/kiosk/events', { kind: 'close_refused' }, { background: true })
        .catch(() => undefined);
    });
    return () => void stop.then((unlisten) => unlisten());
  }, [api]);

  if (!kiosk?.isPos || kiosk.locked) return null;
  return (
    <div className={styles.banner} role="status" data-testid="kiosk-off">
      <LockOpen className={iconClass.sm} aria-hidden="true" />
      <span>
        {t('kiosk.off')}
        {kiosk.offUntil && <> · {t('kiosk.until', { time: formatTime(kiosk.offUntil) })}</>}
      </span>
    </div>
  );
}
