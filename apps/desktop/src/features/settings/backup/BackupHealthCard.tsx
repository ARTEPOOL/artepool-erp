/** The owner dashboard's backup card (decision 0086): what needs attention, with a link. */
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Alert, Card, Note } from '../../../ui';
import { useCan } from '../../auth/context';
import { CardHead } from '../parts';
import styles from './backup.module.css';
import { useHealth } from './BackupPanel';

export function BackupHealthCard({ index }: { index: number }) {
  const { t } = useTranslation('settings');
  const can = useCan();
  const health = useHealth(can('system.health.view'));
  if (!can('system.health.view') || !health.data) return null;
  const { problems } = health.data;
  return (
    <Card rise index={index} data-testid="dashboard-backup">
      <CardHead title={t('backup.title')}>
        <Link to="/settings/backup">{t('backup.open')}</Link>
      </CardHead>
      {problems.length === 0 ? (
        <Note>{t('backup.allGood')}</Note>
      ) : (
        <div className={styles.problems}>
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
