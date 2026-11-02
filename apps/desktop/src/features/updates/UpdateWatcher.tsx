/**
 * "Updating ARTEPOOL" on every PC (decision 0115, 0.9.0). While the server is stopped for an
 * update, its status page refuses every request with "UPDATING": the first refusal brings up this
 * screen over the app. It then asks `/health` every few seconds and shows the steps as they go.
 * When the status page has closed and the new server is starting, it says so; when the server
 * answers again, it compares the server's version with the one the update was for and says
 * whether the update worked. A failed update means the previous version is running and the data
 * is as it was; the owner reads the reason in System health.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { BridgeResponse, ServerVersion, UpdatingHealth } from '@artepool/shared/contracts';
import { useApi } from '../../api/hooks';
import { Button, Dialog, DialogFooter } from '../../ui';
import { useCan } from '../auth/context';
import { StepList } from './StepList';
import styles from './updates.module.css';

/** Below the status page's limit (30 a minute from one PC). */
export const HEALTH_EVERY_MS = 3_000;

type Watch =
  | { kind: 'idle' }
  | { kind: 'updating'; update: UpdatingHealth['update']; restarting: boolean }
  | { kind: 'done'; outcome: 'ok' | 'failed' | 'back'; from: string | null; to: string | null };

function updating(answer: BridgeResponse): UpdatingHealth | null {
  if (answer.kind !== 'response' || answer.status !== 503) return null;
  const body = answer.body as Partial<UpdatingHealth> | null;
  return body && body.status === 'updating' ? (body as UpdatingHealth) : null;
}

const healthy = (answer: BridgeResponse) =>
  answer.kind === 'response' &&
  answer.status === 200 &&
  (answer.body as { status?: unknown } | null)?.status === 'ok';

export function UpdateWatcher() {
  const { t } = useTranslation('shell');
  const api = useApi();
  const can = useCan();
  const queryClient = useQueryClient();
  const [watch, setWatch] = useState<Watch>({ kind: 'idle' });
  const current = useRef(watch);
  current.current = watch;

  // A request refused because the server is being updated.
  useEffect(
    () =>
      api.onError((error) => {
        if (error.code === 'UPDATING' && current.current.kind !== 'updating') {
          setWatch({ kind: 'updating', update: null, restarting: false });
        }
      }),
    [api],
  );

  useEffect(() => {
    if (watch.kind !== 'updating') return;
    let stopped = false;
    const look = async () => {
      const answer = await api.probe('/health');
      const now = current.current;
      if (stopped || now.kind !== 'updating') return;
      const page = updating(answer);
      if (page) {
        setWatch({ kind: 'updating', update: page.update ?? now.update, restarting: false });
        return;
      }
      if (!healthy(answer)) {
        // The status page has closed; the new server (or the previous one) is starting.
        if (!now.restarting) setWatch({ ...now, restarting: true });
        return;
      }
      const update = now.update;
      let outcome: 'ok' | 'failed' | 'back' = 'back';
      if (update?.result && !update.result.ok) {
        outcome = 'failed';
      } else if (update?.to) {
        const version = await api.probe('/api/v1/system/version');
        if (version.kind === 'response' && version.status === 200) {
          outcome = (version.body as ServerVersion).version === update.to ? 'ok' : 'failed';
        }
      }
      if (stopped) return;
      setWatch({ kind: 'done', outcome, from: update?.from ?? null, to: update?.to ?? null });
      // Everything on screen is read again from the server that answers now.
      void queryClient.invalidateQueries();
    };
    void look();
    const timer = setInterval(() => void look(), HEALTH_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [watch.kind, api, queryClient]);

  if (watch.kind === 'updating') {
    return (
      <div
        className={styles.updating}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="server-update-title"
        data-testid="server-updating"
      >
        <div className={styles.updatingPanel}>
          <h2 id="server-update-title" className={styles.updatingTitle}>
            {t('serverUpdate.title')}
          </h2>
          {watch.update && (
            <p className={styles.notes}>
              {t('serverUpdate.versions', {
                from: watch.update.from,
                to: watch.update.to,
              })}
            </p>
          )}
          <StepList steps={watch.update?.steps} restarting={watch.restarting} />
          <p className={styles.notes} role="status">
            {watch.restarting ? t('serverUpdate.restarting') : t('serverUpdate.wait')}
          </p>
        </div>
      </div>
    );
  }
  if (watch.kind === 'done') {
    const close = () => setWatch({ kind: 'idle' });
    return (
      <Dialog isOpen onClose={close} title={t(`serverUpdate.done.${watch.outcome}.title`)}>
        <div data-testid="server-update-done" data-outcome={watch.outcome}>
          <p>{t(`serverUpdate.done.${watch.outcome}.text`, { from: watch.from, to: watch.to })}</p>
          {watch.outcome === 'failed' && can('system.health.view') && (
            <p className={styles.notes}>{t('serverUpdate.done.failed.owner')}</p>
          )}
          <DialogFooter>
            <Button variant="primary" onPress={close}>
              {t('serverUpdate.ok')}
            </Button>
          </DialogFooter>
        </div>
      </Dialog>
    );
  }
  return null;
}
