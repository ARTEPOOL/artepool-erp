import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { version } from '../../package.json';
import { Brand } from '../ui';
import styles from './LoginFrame.module.css';
import { TopTools } from './TopTools';

/**
 * The frame of every screen before the app itself: brand and switches at the top, this PC and
 * the app version at the bottom (design screen 01).
 */
export function LoginFrame({ device, children }: { device?: ReactNode; children?: ReactNode }) {
  const { t } = useTranslation('shell');
  return (
    <div className={styles.login}>
      <div className={styles.top}>
        <Brand className="rise">{t('brand')}</Brand>
        <TopTools />
      </div>
      <main className={styles.middle}>{children}</main>
      <footer className={styles.foot}>
        <span>{device}</span>
        <bdi>{t('version', { version })}</bdi>
      </footer>
    </div>
  );
}
