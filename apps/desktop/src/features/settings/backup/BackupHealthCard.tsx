/**
 * The owner dashboard's system health card (decision 0086, M6.2 part H): what needs attention in
 * the backups and on the server PC (disks, services, certificates, clock, UPS), with a link.
 */
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { ServerHealth, ServerHealthProblem } from '@artepool/shared/contracts';
import { useApi } from '../../../api/hooks';
import { Alert, Card, Note } from '../../../ui';
import { useCan } from '../../auth/context';
import { CardHead } from '../parts';
import styles from './backup.module.css';
import { useHealth } from './BackupPanel';
import { SERVER_HEALTH_KEY } from './ServerHealthCard';

const URGENT: ReadonlySet<ServerHealthProblem> = new Set([
  'disk_urgent',
  'backup_service_down',
  'wal_archive_failed',
  'clock_behind',
]);

/** Red when it needs acting on now; orange when it needs looking at soon. */
function serverTone(p: ServerHealthProblem, s: ServerHealth): 'danger' | 'warn' {
  if (URGENT.has(p)) return 'danger';
  if (p === 'certificate_expiring')
    return s.certificate.server?.level === 'urgent' ? 'danger' : 'warn';
  if (p === 'root_ca_expiring') return s.certificate.rootCa?.level === 'urgent' ? 'danger' : 'warn';
  return 'warn';
}

export function BackupHealthCard({ index }: { index: number }) {
  const { t } = useTranslation('settings');
  const api = useApi();
  const can = useCan();
  const allowed = can('system.health.view');
  const health = useHealth(allowed);
  const server = useQuery({
    queryKey: SERVER_HEALTH_KEY,
    queryFn: () => api.get<ServerHealth>('/api/v1/system/server-health'),
    enabled: allowed,
    refetchInterval: 60_000,
  });
  if (!allowed || !health.data) return null;
  const { problems } = health.data;
  const serverProblems = server.data?.problems ?? [];
  return (
    <Card rise index={index} data-testid="dashboard-backup">
      <CardHead title={t('backup.title')}>
        <Link to="/settings/backup">{t('backup.open')}</Link>
      </CardHead>
      {problems.length === 0 && serverProblems.length === 0 ? (
        <Note>{t('backup.allGood')}</Note>
      ) : (
        <div className={styles.problems}>
          {serverProblems.map((p) => (
            <Alert key={`server-${p}`} tone={serverTone(p, server.data!)}>
              {t(`serverHealth.problem.${p}`)}
            </Alert>
          ))}
          {problems.map((p) => (
            <Alert
              key={p}
              tone={p === 'offsite_not_set_up' || p.endsWith('_due') ? 'warn' : 'danger'}
            >
              {t(`backup.problem.${p}`)}
            </Alert>
          ))}
        </div>
      )}
    </Card>
  );
}
