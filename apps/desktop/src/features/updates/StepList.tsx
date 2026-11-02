/**
 * The five steps of a server update (decision 0115): prepare → stop → backup → database → start,
 * each done, running, failed or not yet; with how long each took on System health.
 */
import { Check, Circle, LoaderCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UPDATE_STEP_NAMES, type UpdateStepRecord } from '@artepool/shared/contracts';
import { cx, iconClass } from '../../ui';
import styles from './updates.module.css';

/** Seconds a step took, or null while it has no end. */
export function stepSeconds(step: Pick<UpdateStepRecord, 'startedAt' | 'endedAt'>): number | null {
  if (!step.startedAt || !step.endedAt) return null;
  const ms = Date.parse(step.endedAt) - Date.parse(step.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

/** "40 s", "1 min 40 s". */
export function useDuration(): (seconds: number) => string {
  const { t } = useTranslation('shell');
  return (seconds) =>
    seconds < 60
      ? t('serverUpdate.seconds', { n: seconds })
      : t('serverUpdate.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

const ICONS = {
  done: Check,
  running: LoaderCircle,
  failed: X,
  pending: Circle,
} as const;

export function StepList(props: {
  /** Null before the first answer: every step not yet. */
  steps: UpdateStepRecord[] | null | undefined;
  /** The status page has stopped while the server starts: "start" is running. */
  restarting?: boolean;
  durations?: boolean;
}) {
  const { t } = useTranslation('shell');
  const duration = useDuration();
  const steps =
    props.steps && props.steps.length > 0
      ? props.steps
      : UPDATE_STEP_NAMES.map((step): UpdateStepRecord => ({
          step,
          state: 'pending',
          startedAt: null,
          endedAt: null,
        }));
  return (
    <ol className={styles.steps} data-testid="update-steps">
      {steps.map((record) => {
        const state =
          props.restarting &&
          record.step === 'start' &&
          record.state !== 'done' &&
          record.state !== 'failed'
            ? 'running'
            : record.state;
        const Icon = ICONS[state];
        const seconds = props.durations ? stepSeconds(record) : null;
        const label = t(`serverUpdate.step.${record.step}`);
        return (
          <li
            key={record.step}
            className={styles.step}
            data-state={state}
            aria-label={`${label}: ${t(`serverUpdate.state.${state}`)}`}
          >
            <Icon
              className={cx(iconClass.sm, state === 'running' && styles.spinning)}
              aria-hidden="true"
            />
            <span>{label}</span>
            {seconds !== null && <span className={styles.duration}>{duration(seconds)}</span>}
          </li>
        );
      })}
    </ol>
  );
}
