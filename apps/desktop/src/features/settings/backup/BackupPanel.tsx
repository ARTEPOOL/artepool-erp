/**
 * Settings → System health (design 13 backup panel; decision 0086, M6.1). Owner only: the last
 * local, off-site and external-drive copies, the restore test, the integrity checks, the disk,
 * what needs attention, and the requests to the backup service.
 */
import { useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  Cloud,
  Database,
  HardDrive,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { BackupRequestBody, BackupRunInfo, HealthResponse } from '@artepool/shared/contracts';
import { useApi, useSave } from '../../../api/hooks';
import { formatDate, formatDateTime } from '../../../lib/format';
import {
  Alert,
  Button,
  Card,
  Chip,
  Dialog,
  DialogFooter,
  iconClass,
  Note,
  tableClasses,
  TextField,
  Tile,
  useToast,
  type Tone,
} from '../../../ui';
import { useCan, useErrorText } from '../../auth/context';
import { CardHead, NoAccess, PanelHeader, settingsClasses } from '../parts';
import styles from './backup.module.css';
import { DriveDialog } from './DriveDialog';
import { KeyDialog } from './KeyDialog';
import { ServerHealthCard } from './ServerHealthCard';
import { UpdatesCard } from './UpdatesCard';

export const HEALTH_KEY = ['settings', 'health'] as const;

export function useHealth(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: HEALTH_KEY,
    queryFn: () => api.get<HealthResponse>('/api/v1/health/system'),
    enabled,
    // While a request waits or runs, follow it.
    refetchInterval: (query) =>
      query.state.data?.requests.some((r) => r.status === 'pending' || r.status === 'running')
        ? 5_000
        : 60_000,
  });
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const when = (run: BackupRunInfo | null) =>
  run?.finishedAt ? formatDateTime(run.finishedAt) : '—';

function Kpi(props: { icon: ReactNode; tone: Tone; label: string; value: string; sub: string }) {
  return (
    <Card className={styles.kpi}>
      <Tile tone={props.tone}>{props.icon}</Tile>
      <div>
        <span className={styles.muted}>{props.label}</span>
        <b>
          <bdi>{props.value}</bdi>
        </b>
        <span className={styles.muted}>{props.sub}</span>
      </div>
    </Card>
  );
}

export function BackupPanel() {
  const { t } = useTranslation('settings');
  const can = useCan();
  const toast = useToast();
  const errorText = useErrorText();
  const health = useHealth(can('system.health.view'));
  const [restoring, setRestoring] = useState(false);
  const [keying, setKeying] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [drive, setDrive] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const ask = useSave(
    (api, body: BackupRequestBody, key) =>
      api.post('/api/v1/backup/requests', body, { idempotencyKey: key }),
    {
      invalidate: [[...HEALTH_KEY]],
      onSuccess: (_, body) => toast(t(`backup.asked.${body.kind}`)),
    },
  );
  const disconnect = useSave(
    (api, _: null, key) => api.post('/api/v1/backup/drive/disconnect', {}, { idempotencyKey: key }),
    { invalidate: [[...HEALTH_KEY]] },
  );

  if (!can('system.health.view')) return <NoAccess />;
  const h = health.data;
  const request = (body: BackupRequestBody) => {
    setProblem(null);
    ask.mutate(body, { onError: (e) => setProblem(errorText(e)) });
  };
  const has = (p: HealthResponse['problems'][number]) => h?.problems.includes(p) ?? false;

  return (
    <>
      <PanelHeader
        title={t('backup.title')}
        subtitle={t('backup.subtitle')}
        tools={
          <span className={settingsClasses.tools}>
            <Button onPress={() => setRestoring(true)}>
              <RefreshCw className={iconClass.sm} aria-hidden="true" />
              {t('backup.restoreTest')}
            </Button>
            <Button
              variant="primary"
              busy={ask.isPending}
              onPress={() => request({ kind: 'backup_now' })}
            >
              <Database className={iconClass.sm} aria-hidden="true" />
              {t('backup.backupNow')}
            </Button>
          </span>
        }
      />
      {health.error && <Alert>{errorText(health.error)}</Alert>}
      {problem && <Alert>{problem}</Alert>}
      {h && h.problems.length > 0 && (
        <div className={styles.problems} data-testid="health-problems">
          {h.problems.map((p) => (
            <Alert
              key={p}
              tone={p === 'offsite_not_set_up' || p.endsWith('_due') ? 'warn' : 'danger'}
            >
              {t(`backup.problem.${p}`)}
            </Alert>
          ))}
        </div>
      )}
      {h && h.problems.length === 0 && (
        <Note className={styles.problems}>{t('backup.allGood')}</Note>
      )}

      {h && (
        <>
          <ServerHealthCard backup={h} onCreateKey={() => setKeying(true)} />
          <div className={styles.kpis}>
            <Kpi
              icon={<Database aria-hidden="true" />}
              tone={has('local_stale') || has('local_failed') ? 'danger' : 'ok'}
              label={t('backup.lastLocal')}
              value={when(h.local.last)}
              sub={t('backup.hourly')}
            />
            <Kpi
              icon={<Cloud aria-hidden="true" />}
              tone={
                has('offsite_not_set_up')
                  ? 'warn'
                  : has('offsite_stale') || has('offsite_failed')
                    ? 'danger'
                    : 'ok'
              }
              label={t('backup.lastOffsite')}
              value={when(h.offsite.last)}
              sub={t('backup.dailyEncrypted')}
            />
            <Kpi
              icon={<ShieldCheck aria-hidden="true" />}
              tone={has('restore_test_failed') ? 'danger' : has('restore_test_due') ? 'warn' : 'ok'}
              label={t('backup.lastRestoreTest')}
              value={
                h.restoreTest.last?.finishedAt ? formatDate(h.restoreTest.last.finishedAt) : '—'
              }
              sub={
                h.restoreTest.last?.status === 'failed'
                  ? t('backup.failed')
                  : t('backup.everyDays', { days: h.restoreTest.intervalDays })
              }
            />
            <Kpi
              icon={<CheckCircle2 aria-hidden="true" />}
              tone={has('integrity_issues') ? 'danger' : h.integrity.last ? 'ok' : 'neutral'}
              label={t('backup.integrity')}
              value={
                h.integrity.last ? t(`backup.integrityStatus.${h.integrity.last.status}`) : '—'
              }
              sub={
                h.integrity.last?.finishedAt
                  ? formatDateTime(h.integrity.last.finishedAt)
                  : t('backup.nightly')
              }
            />
          </div>

          <Card rise index={1}>
            <CardHead title={t('backup.places')} />
            <div className={styles.places}>
              <div className={styles.place}>
                <Tile tone="ok">
                  <Database aria-hidden="true" />
                </Tile>
                <div>
                  <b>{t('backup.localFolder')}</b>
                  <div className={styles.muted}>
                    <bdi>{h.local.folder}</bdi>
                    {h.disk && (
                      <>
                        {' '}
                        ·{' '}
                        {t('backup.free', {
                          free: formatBytes(h.disk.freeBytes),
                          total: formatBytes(h.disk.totalBytes),
                        })}
                      </>
                    )}
                  </div>
                </div>
                {has('disk_low') ? (
                  <Chip tone="danger" icon={<TriangleAlert aria-hidden="true" />}>
                    {t('backup.diskLow')}
                  </Chip>
                ) : (
                  <span />
                )}
              </div>

              <div className={styles.place}>
                <Tile tone={h.offsite.keySet ? 'ok' : 'warn'}>
                  <KeyRound aria-hidden="true" />
                </Tile>
                <div>
                  <b>{t('backup.key')}</b>
                  <div className={styles.muted}>
                    {h.offsite.keySet ? t('backup.keySet') : t('backup.keyMissing')}
                  </div>
                </div>
                <div className={styles.placeActions}>
                  <Button onPress={() => setKeying(true)}>
                    {h.offsite.keySet ? t('backup.replaceKey') : t('backup.createKey')}
                  </Button>
                </div>
              </div>

              <div className={styles.place}>
                <Tile tone={h.offsite.driveConnected ? 'ok' : 'warn'}>
                  <Cloud aria-hidden="true" />
                </Tile>
                <div>
                  <b>{t('backup.googleDrive')}</b>
                  <div className={styles.muted}>
                    {h.offsite.driveConnected
                      ? t('backup.driveConnected')
                      : t('backup.driveNotConnected')}
                    {h.offsite.lastFailure?.errorMessage && has('offsite_failed') && (
                      <>
                        {' '}
                        · <bdi>{h.offsite.lastFailure.errorMessage}</bdi>
                      </>
                    )}
                  </div>
                </div>
                <div className={styles.placeActions}>
                  {h.offsite.driveConnected ? (
                    <>
                      <Button
                        isDisabled={!h.offsite.keySet}
                        onPress={() => request({ kind: 'offsite_now' })}
                      >
                        {t('backup.uploadNow')}
                      </Button>
                      <Button variant="ghost" onPress={() => disconnect.mutate(null)}>
                        {t('backup.disconnect')}
                      </Button>
                    </>
                  ) : (
                    <Button onPress={() => setConnecting(true)}>{t('backup.connectDrive')}</Button>
                  )}
                </div>
              </div>

              <div className={styles.place}>
                <Tile tone={has('offline_due') ? 'warn' : 'ok'}>
                  <HardDrive aria-hidden="true" />
                </Tile>
                <div>
                  <b>{t('backup.externalDrive')}</b>
                  <div className={styles.muted}>
                    {h.offline.last?.finishedAt
                      ? t('backup.lastCopy', { date: formatDate(h.offline.last.finishedAt) })
                      : t('backup.noCopyYet')}{' '}
                    · {t('backup.notEncrypted')}
                  </div>
                </div>
                <div className={styles.drive}>
                  <TextField
                    label={t('backup.driveFolder')}
                    value={drive}
                    onChange={setDrive}
                    placeholder={t('backup.driveExample')}
                    ltr
                  />
                  <Button
                    isDisabled={drive.trim().length < 2}
                    onPress={() => request({ kind: 'offline_copy', target: drive.trim() })}
                  >
                    {t('backup.copyToDrive')}
                  </Button>
                </div>
              </div>
            </div>
          </Card>

          <UpdatesCard />

          {h.integrity.last && Object.keys(h.integrity.last.checks).length > 0 && (
            <Card rise index={2}>
              <CardHead title={t('backup.checks')} />
              <ul className={styles.checks}>
                {Object.entries(h.integrity.last.checks).map(([name, check]) => (
                  <li key={name}>
                    <Chip tone={check.ok ? 'ok' : 'danger'}>
                      {t(`backup.check.${name}`, { defaultValue: name })}
                    </Chip>{' '}
                    {!check.ok && <bdi className={styles.muted}>{check.examples.join(' · ')}</bdi>}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card rise index={3} padding="table">
            <div className={settingsClasses.tblHead}>
              <CardHead title={t('backup.recent')} />
            </div>
            <table className={tableClasses.table} data-testid="backup-requests">
              <thead>
                <tr>
                  <th>{t('backup.colTime')}</th>
                  <th>{t('backup.colWhat')}</th>
                  <th>{t('backup.colResult')}</th>
                </tr>
              </thead>
              <tbody>
                {h.requests.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <bdi>{formatDateTime(r.createdAt)}</bdi>
                    </td>
                    <td>{t(`backup.kind.${r.kind}`)}</td>
                    <td>
                      <Chip
                        tone={
                          r.status === 'done' ? 'ok' : r.status === 'failed' ? 'danger' : 'info'
                        }
                      >
                        {t(`backup.status.${r.status}`)}
                      </Chip>
                      {r.errorMessage && (
                        <span className={tableClasses.sub}>
                          <bdi>{r.errorMessage}</bdi>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {h.requests.length === 0 && (
                  <tr className={tableClasses.empty}>
                    <td colSpan={3}>{t('backup.noRequests')}</td>
                  </tr>
                )}
              </tbody>
            </table>
            <Note className={settingsClasses.tableNote}>{t('backup.automatic')}</Note>
          </Card>
        </>
      )}

      {restoring && (
        <Dialog isOpen onClose={() => setRestoring(false)} title={t('backup.restoreTest')}>
          <div className={styles.form}>
            <p className={settingsClasses.helpText}>{t('backup.restoreHelp')}</p>
            <DialogFooter>
              <Button onPress={() => setRestoring(false)}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                onPress={() => {
                  setRestoring(false);
                  request({ kind: 'restore_test' });
                }}
              >
                {t('backup.startTest')}
              </Button>
            </DialogFooter>
          </div>
        </Dialog>
      )}
      {keying && h && <KeyDialog replacing={h.offsite.keySet} onClose={() => setKeying(false)} />}
      {connecting && h && (
        <DriveDialog google={h.offsite.google} onClose={() => setConnecting(false)} />
      )}
    </>
  );
}
