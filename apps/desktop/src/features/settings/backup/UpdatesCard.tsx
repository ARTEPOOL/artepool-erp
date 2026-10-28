/**
 * System health → updates (decision 0108). Owner only: the version running with "Check now"
 * (0110), a newer version with its release notes (in the screen's language, one point per line),
 * why it is waiting, the last update's result, "Install now" and the night window. Updates come
 * by themselves; without internet they wait.
 */
import { useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { UpdateStatus, UpdateWindowBody } from '@artepool/shared/contracts';
import { useApi, useSave } from '../../../api/hooks';
import { formatDateTime } from '../../../lib/format';
import {
  Alert,
  Button,
  Card,
  Chip,
  Dialog,
  DialogFooter,
  iconClass,
  Note,
  SelectField,
  useToast,
} from '../../../ui';
import { useCan, useErrorText } from '../../auth/context';
import { CardHead, settingsClasses } from '../parts';
import styles from './backup.module.css';

export const UPDATE_KEY = ['settings', 'update'] as const;

const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** "**word**" is shown bold; nothing else in the notes is markup (plain text, never HTML). */
function Inline({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return <>{parts.map((part, i) => (i % 2 === 1 ? <b key={i}>{part}</b> : part))}</>;
}

/** Release notes as written: "- " lines become points, other lines paragraphs. */
export function ReleaseNotes({ text }: { text: string }) {
  const blocks: { points?: string[]; text?: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const point = /^[-•*]\s+(.*)$/.exec(line);
    const last = blocks.at(-1);
    if (point) {
      if (last?.points) last.points.push(point[1]!);
      else blocks.push({ points: [point[1]!] });
    } else blocks.push({ text: line });
  }
  return (
    <div className={styles.notes} data-testid="release-notes">
      {blocks.map((b, i) =>
        b.points ? (
          <ul key={i}>
            {b.points.map((p, j) => (
              <li key={j}>
                <Inline text={p} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            <Inline text={b.text!} />
          </p>
        ),
      )}
    </div>
  );
}

export function UpdatesCard() {
  const { t, i18n } = useTranslation('settings');
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const errorText = useErrorText();
  const [confirming, setConfirming] = useState(false);
  const [windowEdit, setWindowEdit] = useState<UpdateWindowBody | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const status = useQuery({
    queryKey: UPDATE_KEY,
    queryFn: () => api.get<UpdateStatus>('/api/v1/system/update'),
    // While a "Check now" or an "Install now" waits or runs, follow it.
    refetchInterval: (query) => {
      const data = query.state.data;
      const following =
        data?.checking || (data?.request && ['pending', 'running'].includes(data.request.status));
      return following ? 10_000 : 60_000;
    },
  });
  const checkNow = useSave(
    (a, _: null, key) => a.post('/api/v1/system/update/check', {}, { idempotencyKey: key }),
    { invalidate: [[...UPDATE_KEY]], onSuccess: () => toast(t('updates.checkAsked')) },
  );
  const installNow = useSave(
    (a, _: null, key) => a.post('/api/v1/system/update/install-now', {}, { idempotencyKey: key }),
    { invalidate: [[...UPDATE_KEY]], onSuccess: () => toast(t('updates.asked')) },
  );
  const saveWindow = useSave(
    (a, body: UpdateWindowBody, key) =>
      a.put('/api/v1/system/update/window', body, { idempotencyKey: key }),
    { invalidate: [[...UPDATE_KEY]], onSuccess: () => setWindowEdit(null) },
  );

  const u = status.data;
  const manage = can('system.update.manage');
  const open = u?.request && ['pending', 'running'].includes(u.request.status);
  const notes = u?.available
    ? i18n.language === 'ar'
      ? (u.available.notesAr ?? u.available.notesEn)
      : (u.available.notesEn ?? u.available.notesAr)
    : null;
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hour(h) }));

  return (
    <Card rise index={2} aria-label={t('updates.title')}>
      <CardHead title={t('updates.title')} />
      {status.error && <Alert>{errorText(status.error)}</Alert>}
      {problem && <Alert>{problem}</Alert>}
      {u && (
        <div className={styles.places} data-testid="updates-card">
          <div className={styles.place}>
            <span />
            <div>
              <b>
                {t('updates.current')}: <bdi>{u.currentVersion ?? '—'}</bdi>
              </b>
              <div className={styles.muted} data-testid="update-checked">
                {u.checking
                  ? t('updates.checking')
                  : u.checkError
                    ? t('updates.offline')
                    : u.checkedAt
                      ? t('updates.checked', { date: formatDateTime(u.checkedAt) })
                      : t('updates.notChecked')}
              </div>
            </div>
            <div className={styles.placeActions}>
              {!u.available && !u.checkError && !u.checking && u.checkedAt && (
                <Chip tone="ok">{t('updates.upToDate')}</Chip>
              )}
              {manage && (
                <Button
                  busy={checkNow.isPending}
                  isDisabled={u.checking}
                  onPress={() => {
                    setProblem(null);
                    checkNow.mutate(null, { onError: (e) => setProblem(errorText(e)) });
                  }}
                >
                  <RefreshCw className={iconClass.sm} aria-hidden="true" />
                  {t('updates.checkNow')}
                </Button>
              )}
            </div>
          </div>

          {u.available && (
            <div className={styles.place} data-testid="update-available">
              <span />
              <div>
                <b>
                  {t('updates.available')}: <bdi>{u.available.version}</bdi>
                </b>
                {notes && <ReleaseNotes text={notes} />}
                <div className={styles.muted}>
                  {t(`updates.download.${u.downloadStatus}`)}
                  {u.waitingReason && <> · {t(`updates.waiting.${u.waitingReason}`)}</>}
                  {open && <> · {t(`updates.request.${u.request!.status}`)}</>}
                </div>
              </div>
              {manage && (
                <div className={styles.placeActions}>
                  <Button
                    variant="primary"
                    isDisabled={u.downloadStatus !== 'ready' || !!open}
                    onPress={() => setConfirming(true)}
                  >
                    <Download className={iconClass.sm} aria-hidden="true" />
                    {t('updates.installNow')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {u.lastResult && (
            <div className={styles.place}>
              <span />
              <div>
                <b>{t('updates.last')}</b>
                <div className={styles.muted}>
                  {u.lastResult.ok
                    ? t('updates.lastOk', {
                        version: u.lastResult.to,
                        date: formatDateTime(u.lastResult.at),
                      })
                    : t('updates.lastFailed', {
                        version: u.lastResult.to,
                        date: formatDateTime(u.lastResult.at),
                        step: t(`updates.step.${u.lastResult.step ?? 'checks'}`, {
                          defaultValue: u.lastResult.step ?? '',
                        }),
                      })}
                </div>
              </div>
              <Chip tone={u.lastResult.ok ? 'ok' : 'danger'}>
                {u.lastResult.ok ? t('updates.ok') : t('updates.rolledBack')}
              </Chip>
            </div>
          )}

          <div className={styles.place}>
            <span />
            <div>
              <b>{t('updates.window')}</b>
              <div className={styles.muted}>
                {t('updates.windowText', {
                  start: hour(u.window.startHour),
                  end: hour(u.window.endHour),
                })}
              </div>
            </div>
            {manage && (
              <div className={styles.placeActions}>
                <Button onPress={() => setWindowEdit({ ...u.window })}>
                  {t('updates.changeWindow')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
      <Note className={settingsClasses.tableNote}>{t('updates.automatic')}</Note>

      {confirming && u?.available && (
        <Dialog isOpen onClose={() => setConfirming(false)} title={t('updates.installNow')}>
          <div className={styles.form}>
            <p className={settingsClasses.helpText}>
              {t('updates.confirm', { version: u.available.version })}
            </p>
            <DialogFooter>
              <Button onPress={() => setConfirming(false)}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                busy={installNow.isPending}
                onPress={() => {
                  setProblem(null);
                  setConfirming(false);
                  installNow.mutate(null, { onError: (e) => setProblem(errorText(e)) });
                }}
              >
                {t('updates.installNow')}
              </Button>
            </DialogFooter>
          </div>
        </Dialog>
      )}
      {windowEdit && (
        <Dialog isOpen onClose={() => setWindowEdit(null)} title={t('updates.window')}>
          <div className={styles.form}>
            <SelectField
              id="update-window-start"
              label={t('updates.from')}
              value={String(windowEdit.startHour)}
              options={hours}
              onChange={(v) => setWindowEdit({ ...windowEdit, startHour: Number(v) })}
            />
            <SelectField
              id="update-window-end"
              label={t('updates.to')}
              value={String(windowEdit.endHour)}
              options={hours}
              onChange={(v) => setWindowEdit({ ...windowEdit, endHour: Number(v) })}
            />
            {saveWindow.error ? <Alert>{errorText(saveWindow.error)}</Alert> : null}
            <DialogFooter>
              <Button onPress={() => setWindowEdit(null)}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                busy={saveWindow.isPending}
                isDisabled={windowEdit.startHour === windowEdit.endHour}
                onPress={() => saveWindow.mutate(windowEdit)}
              >
                {t('common.save')}
              </Button>
            </DialogFooter>
          </div>
        </Dialog>
      )}
    </Card>
  );
}
