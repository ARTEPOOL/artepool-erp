/**
 * System health → the automated rehearsal (M7 part B, decision 0119). Owner only. «ابدأ البروفة»
 * plays a whole shop day on a separate throwaway database on the server PC: the steps show as
 * they end, then green or red, with the checks, the restored backup, the speed and the seven-step
 * reconciliation report (printed for the accountant). Refused while a shift is open, while an
 * update is installing, while another rehearsal runs, or with less than 2 GB of free disk.
 */
import { useState } from 'react';
import { Check, Circle, LoaderCircle, PlayCircle, Printer, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  REHEARSAL_STEPS,
  type FilePayload,
  type RehearsalRun,
  type RehearsalsResponse,
} from '@artepool/shared/contracts';
import { useApi, useSave } from '../../../api/hooks';
import { formatDateTime } from '../../../lib/format';
import {
  Alert,
  Button,
  Card,
  Chip,
  cx,
  Dialog,
  DialogFooter,
  iconClass,
  useToast,
} from '../../../ui';
import { useCan, useErrorText } from '../../auth/context';
import { printPdf } from '../../sales/print';
import { useDuration } from '../../updates/StepList';
import updateStyles from '../../updates/updates.module.css';
import { CardHead, settingsClasses } from '../parts';
import styles from './backup.module.css';

export const REHEARSAL_KEY = ['settings', 'rehearsals'] as const;

const following = (run: RehearsalRun | null | undefined) =>
  run?.status === 'requested' || run?.status === 'running';

type StepState = 'done' | 'running' | 'failed' | 'pending';

/** Every step of the run with its state: what ended, the one under way, what is still to come. */
export function stepStates(
  run: RehearsalRun,
): { step: string; state: StepState; ms: number | null }[] {
  const ended = new Map(run.steps.map((s) => [s.step, s]));
  const extra = run.steps.filter((s) => !(REHEARSAL_STEPS as readonly string[]).includes(s.step));
  let runningShown = false;
  const rows = REHEARSAL_STEPS.map((step) => {
    const s = ended.get(step);
    if (s) return { step, state: (s.ok ? 'done' : 'failed') as StepState, ms: s.ms };
    if (run.status === 'running' && !runningShown) {
      runningShown = true;
      return { step, state: 'running' as StepState, ms: null };
    }
    return { step, state: 'pending' as StepState, ms: null };
  });
  return [...rows, ...extra.map((s) => ({ step: s.step, state: 'failed' as const, ms: s.ms }))];
}

const ICONS = { done: Check, running: LoaderCircle, failed: X, pending: Circle } as const;

export function RehearsalCard() {
  const { t } = useTranslation('settings');
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const errorText = useErrorText();
  const duration = useDuration();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const runs = useQuery({
    queryKey: REHEARSAL_KEY,
    queryFn: () => api.get<RehearsalsResponse>('/api/v1/system/rehearsals'),
    // While it waits or runs, follow it every few seconds.
    refetchInterval: (query) => (following(query.state.data?.latest) ? 3_000 : 60_000),
  });
  const start = useSave(
    (a, _: null, key) =>
      a.post<RehearsalRun>('/api/v1/system/rehearsals', {}, { idempotencyKey: key }),
    { invalidate: [[...REHEARSAL_KEY]], onSuccess: () => toast(t('rehearsal.asked')) },
  );

  const data = runs.data;
  const run = data?.latest ?? null;
  const manage = can('system.rehearsal');
  const states = run ? stepStates(run) : [];
  const total = REHEARSAL_STEPS.length;
  const done = run ? run.steps.filter((s) => s.ok).length : 0;
  const percent = Math.min(100, Math.round((done / total) * 100));
  const result = run?.result ?? null;
  const checks = result?.checks ? Object.values(result.checks) : [];
  const print = async () => {
    if (!run) return;
    setPrinting(true);
    setProblem(null);
    try {
      await printPdf(
        await api.get<FilePayload>(`/api/v1/system/rehearsals/${run.id}/reconciliation/pdf`),
      );
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setPrinting(false);
    }
  };
  const seconds = (ms: number) => duration(Math.max(0, Math.round(ms / 1000)));

  return (
    <Card rise index={2} aria-label={t('rehearsal.title')}>
      <CardHead title={t('rehearsal.title')} />
      {runs.error && <Alert>{errorText(runs.error)}</Alert>}
      {problem && <Alert>{problem}</Alert>}
      {data && (
        <div className={styles.places} data-testid="rehearsal-card">
          <div className={styles.place}>
            <PlayCircle className={iconClass.md} aria-hidden="true" />
            <div>
              <b>{t('rehearsal.what')}</b>
              <div className={styles.muted}>{t('rehearsal.whatNote')}</div>
              {data.blocked && data.blocked !== 'running' && (
                <div className={styles.muted} data-testid="rehearsal-blocked">
                  {t(`rehearsal.blocked.${data.blocked}`)}
                </div>
              )}
            </div>
            {manage && (
              <div className={styles.placeActions}>
                <Button
                  variant="primary"
                  isDisabled={data.blocked !== null}
                  onPress={() => setConfirming(true)}
                >
                  {t('rehearsal.start')}
                </Button>
              </div>
            )}
          </div>

          {run && (
            <div className={styles.place} data-testid="rehearsal-run">
              <span />
              <div>
                <b>
                  {following(run) ? (
                    t(`rehearsal.status.${run.status}`)
                  ) : (
                    <Chip tone={run.status === 'passed' ? 'ok' : 'danger'}>
                      {t(`rehearsal.status.${run.status}`)}
                    </Chip>
                  )}
                </b>
                <div className={styles.muted}>
                  {t('rehearsal.requested', { date: formatDateTime(run.requestedAt) })}
                  {run.finishedAt && (
                    <> · {t('rehearsal.finished', { date: formatDateTime(run.finishedAt) })}</>
                  )}
                </div>
                {run.status === 'running' && (
                  <div className={styles.progress} data-testid="rehearsal-progress">
                    <div
                      className={styles.progressTrack}
                      role="progressbar"
                      aria-label={t('rehearsal.progress')}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                    >
                      <div className={styles.progressBar} style={{ inlineSize: `${percent}%` }} />
                    </div>
                    <div className={styles.muted}>
                      <bdi>{percent}%</bdi> · {t('rehearsal.steps', { done, total })}
                    </div>
                  </div>
                )}
                {run.failure && (
                  <div className={styles.muted} data-testid="rehearsal-failure">
                    {t('rehearsal.reason')}: <bdi>{run.failure}</bdi>
                  </div>
                )}
                {result && (
                  <ul className={styles.checks} data-testid="rehearsal-result">
                    <li>
                      {checks.every((c) => c.ok) ? '✓' : '✗'}{' '}
                      {t('rehearsal.checks', {
                        ok: checks.filter((c) => c.ok).length,
                        total: checks.length,
                      })}
                    </li>
                    {result.restoredChecks && (
                      <li>
                        {Object.values(result.restoredChecks).every((c) => c.ok) ? '✓' : '✗'}{' '}
                        {t('rehearsal.restored')}
                      </li>
                    )}
                    {result.reconciliation && (
                      <li>
                        {result.reconciliation.ok ? '✓' : '✗'}{' '}
                        {t('rehearsal.reconciliation', {
                          ok: result.reconciliation.steps.filter((s) => s.ok).length,
                          total: result.reconciliation.steps.length,
                        })}
                      </li>
                    )}
                    {result.speed && (
                      <li>
                        {Object.values(result.speed).some((f) => f.slow) ? '✗' : '✓'}{' '}
                        {t('rehearsal.speed', {
                          search: result.speed.search.p95Ms ?? '—',
                          sale: result.speed.sale.p95Ms ?? '—',
                        })}
                      </li>
                    )}
                  </ul>
                )}
                <ol className={updateStyles.steps} data-testid="rehearsal-steps">
                  {states.map((s) => {
                    const Icon = ICONS[s.state];
                    const label = t(`rehearsal.step.${s.step}`, { defaultValue: s.step });
                    return (
                      <li
                        key={s.step}
                        className={updateStyles.step}
                        data-state={s.state}
                        aria-label={`${label}: ${t(`rehearsal.state.${s.state}`)}`}
                      >
                        <Icon
                          className={cx(
                            iconClass.sm,
                            s.state === 'running' && updateStyles.spinning,
                          )}
                          aria-hidden="true"
                        />
                        <span>{label}</span>
                        {s.ms !== null && (
                          <span className={updateStyles.duration}>{seconds(s.ms)}</span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
              {result?.reconciliation && can('reports.reconciliation') && (
                <div className={styles.placeActions}>
                  <Button busy={printing} onPress={() => void print()}>
                    <Printer className={iconClass.sm} aria-hidden="true" />
                    {t('rehearsal.print')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {confirming && (
        <Dialog isOpen onClose={() => setConfirming(false)} title={t('rehearsal.start')}>
          <div className={styles.form}>
            <p className={settingsClasses.helpText}>{t('rehearsal.confirm')}</p>
            <DialogFooter>
              <Button onPress={() => setConfirming(false)}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                busy={start.isPending}
                onPress={() => {
                  setProblem(null);
                  setConfirming(false);
                  start.mutate(null, { onError: (e) => setProblem(errorText(e)) });
                }}
              >
                {t('rehearsal.start')}
              </Button>
            </DialogFooter>
          </div>
        </Dialog>
      )}
    </Card>
  );
}
