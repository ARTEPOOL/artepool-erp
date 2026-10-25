/**
 * Settings → Devices: the "Kiosk lock" of each POS PC (decisions 0082, 0083, 0089, 0091). On by
 * default, and off by itself while the owner is signed in on that PC. Only the owner turns it off — for 15 minutes, 1 hour or until turned back on — or on
 * again, every time with a reason and the current 2-step code. Off lifts only the screen lock: PIN
 * sign-in, shifts and permissions stay the same. The kiosk alerts card lists the latest changes
 * and attempts to leave the app.
 */
import { useState, type FormEvent } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { DeviceListItem, KioskAlertsResponse, KioskLock } from '@artepool/shared/contracts';
import { formatDateTime, formatTime } from '../../../lib/format';
import {
  Alert,
  Button,
  Card,
  Chip,
  Dialog,
  DialogFooter,
  Note,
  Segmented,
  tableClasses,
  TextField,
  useToast,
} from '../../../ui';
import { useCan, useErrorText } from '../../auth/context';
import { OtpInput } from '../../auth/OtpInput';
import { KEYS, useApi, useSave } from '../api';
import { CardHead, settingsClasses as styles } from '../parts';
import deviceStyles from './devices.module.css';

const ALERTS_KEY = ['settings', 'kiosk-alerts'] as const;
type Duration = '15' | '60' | 'untilOn';

/** The lock's state under the PC's status, and the button that changes it. */
export function KioskLockCell({ device }: { device: DeviceListItem }) {
  const { t } = useTranslation('settings');
  const [changing, setChanging] = useState(false);
  const lock = device.kioskLock;
  if (!lock) return null;
  return (
    <span className={deviceStyles.kiosk}>
      {lock.switchedOff ? (
        <Chip tone="warn" icon={<LockOpen aria-hidden="true" />}>
          {lock.offUntil
            ? t('devices.kiosk.offUntil', { time: formatTime(lock.offUntil) })
            : t('devices.kiosk.off')}
        </Chip>
      ) : lock.ownerSignedIn ? (
        <Chip tone="warn" icon={<LockOpen aria-hidden="true" />}>
          {t('devices.kiosk.ownerIn')}
        </Chip>
      ) : (
        <Chip tone="ok" icon={<Lock aria-hidden="true" />}>
          {t('devices.kiosk.on')}
        </Chip>
      )}
      <Button variant="ghost" onPress={() => setChanging(true)}>
        {lock.switchedOff ? t('devices.kiosk.turnOn') : t('devices.kiosk.turnOff')}
      </Button>
      {changing && (
        <KioskLockDialog
          device={device}
          turnOn={lock.switchedOff}
          onClose={() => setChanging(false)}
        />
      )}
    </span>
  );
}

function KioskLockDialog(props: { device: DeviceListItem; turnOn: boolean; onClose: () => void }) {
  const { device, turnOn, onClose } = props;
  const { t } = useTranslation('settings');
  const errorText = useErrorText();
  const toast = useToast();
  const [duration, setDuration] = useState<Duration>('15');
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const change = useSave(
    (api, body: { on: boolean; minutes: 15 | 60 | null; reason: string; code: string }, key) =>
      api.post<KioskLock>(`/api/v1/devices/${device.id}/kiosk-lock`, body, {
        idempotencyKey: key,
      }),
    {
      invalidate: [KEYS.devices, [...ALERTS_KEY]],
      onSuccess: (lock) => {
        toast(
          !lock.switchedOff
            ? t('devices.kiosk.turnedOn', { code: device.code })
            : t('devices.kiosk.turnedOff', { code: device.code }),
        );
        onClose();
      },
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim().length < 3) return setError(t('common.reasonShort'));
    if (!/^\d{6}$/.test(code)) return setError(t('devices.kiosk.codeMissing'));
    setError(null);
    change.mutate(
      {
        on: turnOn,
        minutes: turnOn || duration === 'untilOn' ? null : duration === '15' ? 15 : 60,
        reason: reason.trim(),
        code,
      },
      {
        onError: (caught) => {
          setCode('');
          setError(errorText(caught));
        },
      },
    );
  };
  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={turnOn ? t('devices.kiosk.turnOnTitle') : t('devices.kiosk.turnOffTitle')}
    >
      <form className={deviceStyles.kioskForm} onSubmit={submit} noValidate>
        <p className={styles.helpText}>
          <b>
            <bdi>{device.code}</bdi>
          </b>{' '}
          · <bdi>{device.name}</bdi>
        </p>
        <Note>{turnOn ? t('devices.kiosk.turnOnNote') : t('devices.kiosk.turnOffNote')}</Note>
        {!turnOn && (
          <Segmented
            label={t('devices.kiosk.duration')}
            block
            value={duration}
            onChange={setDuration}
            options={[
              { value: '15', label: t('devices.kiosk.minutes15') },
              { value: '60', label: t('devices.kiosk.hour1') },
              { value: 'untilOn', label: t('devices.kiosk.untilOn') },
            ]}
          />
        )}
        <TextField label={t('devices.kiosk.reason')} value={reason} onChange={setReason} />
        <OtpInput label={t('devices.kiosk.code')} value={code} onChange={setCode} />
        {error && <Alert>{error}</Alert>}
        <DialogFooter>
          <Button onPress={onClose}>{t('common.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            busy={change.isPending}
            isDisabled={change.isPending}
          >
            {turnOn ? t('devices.kiosk.turnOn') : t('devices.kiosk.turnOff')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * The latest kiosk alerts (30 days): lock turned off or on, attempts to leave the app. Also on
 * the owner dashboard (decision 0082), there only the newest few and only when there are any.
 */
export function KioskAlertsCard(props: { index: number; limit?: number; hideWhenEmpty?: boolean }) {
  const { index, limit, hideWhenEmpty = false } = props;
  const { t } = useTranslation('settings');
  const api = useApi();
  const can = useCan();
  const alerts = useQuery({
    queryKey: ALERTS_KEY,
    queryFn: () => api.get<KioskAlertsResponse>('/api/v1/kiosk/alerts'),
    enabled: can('system.devices.manage'),
  });
  const list = (alerts.data?.alerts ?? []).slice(0, limit);
  if (!can('system.devices.manage') || (hideWhenEmpty && list.length === 0)) return null;
  return (
    <Card rise index={index}>
      <CardHead title={t('devices.kiosk.alertsTitle')} />
      <p className={styles.helpText}>{t('devices.kiosk.alertsHelp')}</p>
      {list.length === 0 ? (
        <Note>{t('devices.kiosk.noAlerts')}</Note>
      ) : (
        <ul className={deviceStyles.kioskAlerts} data-testid="kiosk-alerts">
          {list.map((alert) => (
            <li key={alert.id}>
              <b>
                <bdi>{alert.deviceCode}</bdi>
              </b>{' '}
              · {kioskAlertText(t, alert.alertType, alert.params)}
              <span className={tableClasses.sub}>
                <bdi>{formatDateTime(alert.createdAt)}</bdi>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function kioskAlertText(
  t: (key: string, options?: Record<string, unknown>) => string,
  type: string,
  params: Record<string, unknown>,
): string {
  if (type === 'kiosk_lock_off') {
    if (params.via === 'owner_code') return t('devices.kiosk.alert.offByCode');
    return typeof params.minutes === 'number'
      ? t('devices.kiosk.alert.offFor', { minutes: params.minutes })
      : t('devices.kiosk.alert.offUntilOn');
  }
  if (type === 'kiosk_lock_on')
    return params.expired === true
      ? t('devices.kiosk.alert.onExpired')
      : t('devices.kiosk.alert.on');
  if (type === 'kiosk_exit_attempt') return t('devices.kiosk.alert.exitAttempt');
  return t('devices.kiosk.alert.codeBlocked');
}
