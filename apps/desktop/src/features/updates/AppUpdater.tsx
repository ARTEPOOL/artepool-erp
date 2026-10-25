/**
 * The office PCs' app updates itself (decision 0108): it looks for a newer signed version when it
 * starts and every few hours. While nobody is signed in (the sign-in screen, or "update needed")
 * it installs at once; otherwise it shows a notice with the release notes and "Install and
 * restart", so nobody loses their work. The server PC's app is updated with the server instead.
 */
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, iconClass } from '../../ui';
import { useAuthState } from '../auth/context';
import { checkAppUpdate, installAppUpdate, type AppUpdate } from './bridge';
import styles from './updates.module.css';

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Nobody is working in these: an update can install at once. */
const IDLE_PHASES = new Set(['signIn', 'outdated', 'enroll']);

export function AppUpdater() {
  const { t, i18n } = useTranslation('shell');
  const { phase } = useAuthState();
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;
    const look = () =>
      void checkAppUpdate().then((found) => {
        if (!stopped) setUpdate(found);
      });
    look();
    const timer = setInterval(look, CHECK_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const install = () => {
    setInstalling(true);
    setFailed(false);
    installAppUpdate().catch(() => {
      setInstalling(false);
      setFailed(true);
    });
  };

  const idle = IDLE_PHASES.has(phase.name);
  useEffect(() => {
    if (update && idle && !installing && !failed) install();
  }, [update, idle]);

  if (!update) return null;
  const notes = i18n.language === 'ar' ? (update.notesAr ?? update.notesEn) : update.notesEn;
  return (
    <div className={styles.notice} role="status" data-testid="app-update">
      <div>
        <b>{t('appUpdate.ready', { version: update.version })}</b>
        {notes && <p className={styles.notes}>{notes}</p>}
        {failed && <p className={styles.notes}>{t('appUpdate.failed')}</p>}
      </div>
      <Button variant="primary" busy={installing} onPress={install}>
        <Download className={iconClass.sm} aria-hidden="true" />
        {installing ? t('appUpdate.installing') : t('appUpdate.install')}
      </Button>
    </div>
  );
}
