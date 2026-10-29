/**
 * System health → the server PC (M6.2 part H). Owner only. One line each, green, orange or red:
 * the last backup with its age, the backup key, the disks, the services and WAL archiving, the
 * server certificate (it renews itself) and the root CA (renewed by hand), the clock, the UPS, and
 * the protection from power cuts with the integrity check after the database's last start (part I).
 */
import type { ReactNode } from 'react';
import {
  BatteryCharging,
  Clock,
  Database,
  HardDrive,
  KeyRound,
  PlugZap,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type {
  CertificateInfo,
  HealthLevel,
  HealthResponse,
  ServerHealth,
} from '@artepool/shared/contracts';
import { useApi, useSave } from '../../../api/hooks';
import { formatDate, formatDateTime } from '../../../lib/format';
import { Alert, Button, Card, Chip, Tile, useToast, type Tone } from '../../../ui';
import { useCan, useErrorText } from '../../auth/context';
import { CardHead } from '../parts';
import styles from './backup.module.css';
import { formatBytes } from './BackupPanel';

export const SERVER_HEALTH_KEY = ['settings', 'server-health'] as const;

const TONE: Record<HealthLevel, Tone> = { ok: 'ok', warning: 'warn', urgent: 'danger' };

/** Red when a power-cut setting is off or the check after the last start found problems. */
function databaseLevel(d: ServerHealth['database']): HealthLevel {
  if (!d.durability.ok) return 'urgent';
  if (d.startCheck && (d.startCheck.status === 'issues' || d.startCheck.status === 'error'))
    return 'urgent';
  return 'ok';
}

/** "3 hours ago", "2 days ago": the age of the last backup. */
function ageText(iso: string, t: (key: string, o?: Record<string, unknown>) => string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return t('serverHealth.age.minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('serverHealth.age.hours', { count: hours });
  return t('serverHealth.age.days', { count: Math.round(hours / 24) });
}

function Line(props: {
  icon: ReactNode;
  tone: Tone;
  title: string;
  detail: ReactNode;
  end?: ReactNode;
  testId: string;
}) {
  return (
    <div className={styles.place} data-testid={props.testId}>
      <Tile tone={props.tone}>{props.icon}</Tile>
      <div>
        <b>{props.title}</b>
        <div className={styles.muted}>{props.detail}</div>
      </div>
      {props.end ?? <span />}
    </div>
  );
}

export function ServerHealthCard(props: { backup: HealthResponse; onCreateKey: () => void }) {
  const { t } = useTranslation('settings');
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const errorText = useErrorText();
  const health = useQuery({
    queryKey: SERVER_HEALTH_KEY,
    queryFn: () => api.get<ServerHealth>('/api/v1/system/server-health'),
    refetchInterval: 60_000,
  });
  const confirmUps = useSave(
    (a, _: null, key) => a.post('/api/v1/system/server-health/ups', {}, { idempotencyKey: key }),
    {
      invalidate: [[...SERVER_HEALTH_KEY]],
      onSuccess: () => toast(t('serverHealth.ups.thanks')),
    },
  );
  const s = health.data;
  const b = props.backup;
  const backupLate = b.problems.includes('local_stale') || b.problems.includes('local_failed');
  const chip = (level: HealthLevel) => (
    <Chip tone={TONE[level]}>{t(`serverHealth.level.${level}`)}</Chip>
  );
  const certText = (c: CertificateInfo) =>
    c.daysLeft < 0
      ? t('serverHealth.cert.expired', { date: formatDate(c.expiresAt) })
      : t('serverHealth.cert.until', { date: formatDate(c.expiresAt), count: c.daysLeft });

  return (
    <Card rise index={0} aria-label={t('serverHealth.title')} className={styles.serverCard}>
      <CardHead title={t('serverHealth.title')} />
      {health.error && <Alert>{errorText(health.error)}</Alert>}
      {confirmUps.error ? <Alert>{errorText(confirmUps.error)}</Alert> : null}
      <div className={styles.places} data-testid="server-health">
        <Line
          testId="health-backup"
          icon={<Database aria-hidden="true" />}
          tone={backupLate ? 'danger' : b.local.last ? 'ok' : 'warn'}
          title={t('serverHealth.lastBackup')}
          detail={
            b.local.last?.finishedAt
              ? `${formatDateTime(b.local.last.finishedAt)} · ${ageText(b.local.last.finishedAt, t)}`
              : t('serverHealth.noBackupYet')
          }
        />
        <Line
          testId="health-key"
          icon={<KeyRound aria-hidden="true" />}
          tone={b.offsite.keySet ? 'ok' : 'warn'}
          title={t('serverHealth.backupKey')}
          detail={b.offsite.keySet ? t('backup.keySet') : t('backup.keyMissing')}
          end={
            !b.offsite.keySet && can('system.backup.manage') ? (
              <div className={styles.placeActions}>
                <Button onPress={props.onCreateKey}>{t('serverHealth.createKey')}</Button>
              </div>
            ) : undefined
          }
        />

        {s?.disks.map((d) => (
          <Line
            key={d.disk}
            testId={`health-disk-${d.disk}`}
            icon={<HardDrive aria-hidden="true" />}
            tone={TONE[d.level]}
            title={t(`serverHealth.disk.${d.disk}`)}
            detail={
              <>
                {t('backup.free', {
                  free: formatBytes(d.freeBytes),
                  total: formatBytes(d.totalBytes),
                })}{' '}
                · <bdi>{d.path}</bdi>
              </>
            }
            end={chip(d.level)}
          />
        ))}

        {s && (
          <>
            <Line
              testId="health-services"
              icon={<Server aria-hidden="true" />}
              tone={s.services.backupRunning && !s.wal.failing ? 'ok' : 'danger'}
              title={t('serverHealth.services.title')}
              detail={
                <>
                  {t('serverHealth.services.databaseServer')} ·{' '}
                  {s.services.backupRunning
                    ? t('serverHealth.services.backupRunning')
                    : t('serverHealth.services.backupStopped')}{' '}
                  ·{' '}
                  {!s.wal.enabled
                    ? t('serverHealth.wal.off')
                    : s.wal.failing
                      ? t('serverHealth.wal.failing')
                      : t('serverHealth.wal.ok')}
                </>
              }
              end={chip(s.services.backupRunning && !s.wal.failing ? 'ok' : 'urgent')}
            />
            <Line
              testId="health-certificate"
              icon={<ShieldCheck aria-hidden="true" />}
              tone={s.certificate.server ? TONE[s.certificate.server.level] : 'neutral'}
              title={t('serverHealth.cert.server')}
              detail={
                <>
                  {s.certificate.server ? certText(s.certificate.server) : '—'}
                  {' · '}
                  {s.certificate.renewalError
                    ? t('serverHealth.cert.renewalFailed')
                    : s.certificate.lastRenewedAt
                      ? t('serverHealth.cert.renewedOn', {
                          date: formatDate(s.certificate.lastRenewedAt),
                        })
                      : t('serverHealth.cert.renewsItself')}
                </>
              }
              end={s.certificate.server ? chip(s.certificate.server.level) : undefined}
            />
            <Line
              testId="health-root-ca"
              icon={<ShieldCheck aria-hidden="true" />}
              tone={s.certificate.rootCa ? TONE[s.certificate.rootCa.level] : 'neutral'}
              title={t('serverHealth.cert.rootCa')}
              detail={
                <>
                  {s.certificate.rootCa ? certText(s.certificate.rootCa) : '—'}
                  {' · '}
                  {t('serverHealth.cert.rootCaManual')}
                </>
              }
              end={s.certificate.rootCa ? chip(s.certificate.rootCa.level) : undefined}
            />
            <Line
              testId="health-clock"
              icon={<Clock aria-hidden="true" />}
              tone={s.clock.isBehind ? 'danger' : 'ok'}
              title={t('serverHealth.clock.title')}
              detail={
                s.clock.isBehind
                  ? t('serverHealth.clock.behind')
                  : t('serverHealth.clock.ok', { time: formatDateTime(s.clock.serverTime) })
              }
              end={chip(s.clock.isBehind ? 'urgent' : 'ok')}
            />
            <Line
              testId="health-ups"
              icon={<BatteryCharging aria-hidden="true" />}
              tone={s.ups.due ? 'warn' : 'ok'}
              title={t('serverHealth.ups.title')}
              detail={
                s.ups.confirmedAt
                  ? t('serverHealth.ups.confirmed', { date: formatDate(s.ups.confirmedAt) })
                  : t('serverHealth.ups.question')
              }
              end={
                s.ups.due && can('system.health.manage') ? (
                  <div className={styles.placeActions}>
                    <Button busy={confirmUps.isPending} onPress={() => confirmUps.mutate(null)}>
                      {t('serverHealth.ups.confirm')}
                    </Button>
                  </div>
                ) : (
                  chip(s.ups.due ? 'warning' : 'ok')
                )
              }
            />
            <Line
              testId="health-database"
              icon={<PlugZap aria-hidden="true" />}
              tone={TONE[databaseLevel(s.database)]}
              title={t('serverHealth.database.title')}
              detail={
                <>
                  {s.database.durability.ok
                    ? t('serverHealth.database.on')
                    : t('serverHealth.database.off', {
                        list: s.database.durability.off.join(', '),
                      })}
                  <br />
                  {t('serverHealth.database.started', {
                    time: formatDateTime(s.database.startedAt),
                  })}
                  {' · '}
                  {t(`serverHealth.database.check.${s.database.startCheck?.status ?? 'pending'}`)}
                </>
              }
              end={chip(databaseLevel(s.database))}
            />
          </>
        )}
      </div>
    </Card>
  );
}
