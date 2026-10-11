import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import { Alert, Button, iconClass } from '../../../ui';
import { useErrorText } from '../../auth/context';
import styles from './company.module.css';

export const isStale = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'STALE_VERSION';

/**
 * Why a save was refused. "Someone else changed this" comes with a Reload button: the screen
 * never overwrites another person's save without them seeing it first.
 */
export function SaveProblem({
  error,
  onReload,
  reloading = false,
}: {
  error: unknown;
  onReload: () => void;
  reloading?: boolean;
}) {
  const { t } = useTranslation('masterdata');
  const errorText = useErrorText();
  if (!error) return null;
  if (!isStale(error)) return <Alert>{errorText(error)}</Alert>;
  return (
    <Alert tone="warn">
      <div className={styles.stale}>
        <span>{t('stale')}</span>
        <Button busy={reloading} isDisabled={reloading} onPress={onReload}>
          <RefreshCw className={iconClass.sm} aria-hidden="true" />
          {t('actions.reload')}
        </Button>
      </div>
    </Alert>
  );
}
