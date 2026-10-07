/** Small pieces shared by the sign-in screens (design 01). */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LoginFrame } from '../../app/LoginFrame';
import { Alert, Button, Chip, cx, iconClass, useToast } from '../../ui';
import styles from './auth.module.css';
import { useAuthController, useAuthState } from './context';

/** The sign-in frame with this PC's name and code at the bottom. */
export function AuthFrame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const { t } = useTranslation('shell');
  const { device } = useAuthState();
  return (
    <LoginFrame
      device={
        device ? (
          <>
            <bdi>{device.name}</bdi> · <bdi>{device.code}</bdi>
          </>
        ) : (
          t('device.notEnrolled')
        )
      }
    >
      <div className={cx(styles.box, wide && styles.wide)}>{children}</div>
    </LoginFrame>
  );
}

/** Title and one line under it, rising in like the design. */
export function Hello({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className={cx(styles.hello, 'rise')} style={{ '--i': 1 } as CSSProperties}>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

/** "Connected to main server" / "Main server unreachable" under the form. */
export function ServerChip() {
  const { t } = useTranslation('shell');
  const { server } = useAuthState();
  const down = server === 'down' || server === 'untrusted';
  return (
    <div className={cx(styles.centered, 'rise')} style={{ '--i': 3 } as CSSProperties}>
      {down ? (
        <Chip tone="danger" icon={<XCircle className={iconClass.md} aria-hidden="true" />}>
          {t('server.unreachable')}
        </Chip>
      ) : (
        <Chip tone="ok" icon={<CheckCircle2 className={iconClass.md} aria-hidden="true" />}>
          {t('server.connected')}
        </Chip>
      )}
    </div>
  );
}

/** The design's "server down" message with its "Try again" button. */
export function ServerDown() {
  const { t } = useTranslation('auth');
  const controller = useAuthController();
  const { server } = useAuthState();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (server !== 'down' && server !== 'untrusted') return null;
  const retry = async () => {
    setBusy(true);
    try {
      if (await controller.retry()) toast(t('server.back'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert icon={<XCircle aria-hidden="true" />}>
      {server === 'untrusted' ? t('server.untrusted') : t('server.down')}
      <div className={styles.retry}>
        <Button onPress={() => void retry()} busy={busy} isDisabled={busy}>
          <RefreshCw className={iconClass.sm} aria-hidden="true" />
          {busy ? t('server.connecting') : t('server.retry')}
        </Button>
      </div>
    </Alert>
  );
}
