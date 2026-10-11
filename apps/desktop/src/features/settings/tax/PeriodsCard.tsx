import { useState, type FormEvent, type ReactNode } from 'react';
import { CalendarCheck, Lock, LockOpen, RotateCcw, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PeriodItem, PeriodsResponse, PeriodStatus } from '@artepool/shared/contracts';
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
  tableClasses,
  TextField,
  useToast,
  type Tone,
} from '../../../ui';
import { useCan } from '../../auth/context';
import { MD_KEYS } from '../../masterdata/refs';
import { CardHead, settingsClasses } from '../parts';
import { SaveProblem } from '../company/SaveProblem';
import { hasEnded, monthName, RECENT_MONTHS } from './periods';
import styles from './tax.module.css';

const STATUS: Record<PeriodStatus, { tone: Tone; icon: ReactNode }> = {
  open: { tone: 'ok', icon: <LockOpen aria-hidden="true" /> },
  closed: { tone: 'warn', icon: <CalendarCheck aria-hidden="true" /> },
  locked: { tone: 'info', icon: <Lock aria-hidden="true" /> },
};

/**
 * Design 13 → VAT & numbering → "Accounting periods" (decisions 0016, 0035): open → closed →
 * locked, in month order. A month closes only after it ends; reopening needs a reason; locking
 * is for good. The server enforces every step again.
 */
export function PeriodsCard({ index }: { index: number }) {
  const { t, i18n } = useTranslation('setup');
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const manage = can('periods.manage');
  const [showAll, setShowAll] = useState(false);
  const [reopening, setReopening] = useState<PeriodItem | null>(null);
  const [locking, setLocking] = useState<PeriodItem | null>(null);
  const [error, setError] = useState<unknown>(null);
  const periods = useQuery({
    queryKey: MD_KEYS.periods,
    queryFn: () => api.get<PeriodsResponse>('/api/v1/periods'),
  });
  const close = useSave(
    (client, period: PeriodItem, key) =>
      client.post(
        `/api/v1/periods/${period.id}/close`,
        { rowVersion: period.rowVersion },
        { idempotencyKey: key },
      ),
    {
      invalidate: [MD_KEYS.periods],
      onSuccess: (_, period) =>
        toast(
          t('tax.periods.closedToast', { month: monthName(period.periodStart, i18n.language) }),
        ),
    },
  );

  const list = periods.data?.periods ?? [];
  const today = periods.data?.today ?? '';
  const shown = showAll ? list : list.slice(0, RECENT_MONTHS);
  const month = (period: PeriodItem) => monthName(period.periodStart, i18n.language);
  const who = (name: string | null, at: string | null) =>
    at ? (
      <>
        <bdi>{name ?? '—'}</bdi>
        <span className={tableClasses.sub}>
          <bdi>{formatDateTime(at)}</bdi>
        </span>
      </>
    ) : (
      '—'
    );

  return (
    <Card rise index={index} padding="table">
      <div className={settingsClasses.tblHead}>
        <CardHead title={t('tax.periods.title')} />
      </div>
      <SaveProblem
        error={error}
        onReload={() => {
          setError(null);
          void queryClient.invalidateQueries({ queryKey: MD_KEYS.periods });
        }}
      />
      <table className={tableClasses.table}>
        <thead>
          <tr>
            <th>{t('tax.periods.month')}</th>
            <th>{t('tax.periods.status')}</th>
            <th>{t('tax.periods.closedBy')}</th>
            <th>{t('tax.periods.lockedBy')}</th>
            {manage && <th />}
          </tr>
        </thead>
        <tbody>
          {shown.map((period) => {
            const ended = hasEnded(period, today);
            return (
              <tr key={period.id}>
                <td>
                  <b>{month(period)}</b>
                </td>
                <td>
                  <Chip tone={STATUS[period.status].tone} icon={STATUS[period.status].icon}>
                    {t(`tax.periods.statuses.${period.status}`)}
                  </Chip>
                </td>
                <td>{who(period.closedByName, period.closedAt)}</td>
                <td>{who(period.lockedByName, period.lockedAt)}</td>
                {manage && (
                  <td className={tableClasses.num}>
                    <span className={styles.actions}>
                      {period.status === 'open' && (
                        <>
                          <Button
                            aria-label={t('tax.periods.closeMonth', { month: month(period) })}
                            isDisabled={!ended || close.isPending}
                            busy={close.isPending && close.variables.id === period.id}
                            onPress={() => {
                              setError(null);
                              close.mutate(period, { onError: setError });
                            }}
                          >
                            <CalendarCheck className={iconClass.sm} aria-hidden="true" />
                            {t('tax.periods.close')}
                          </Button>
                          {!ended && (
                            <span className={tableClasses.sub}>
                              {t('tax.periods.notEnded', { date: period.periodEnd })}
                            </span>
                          )}
                        </>
                      )}
                      {period.status === 'closed' && (
                        <>
                          <Button
                            variant="ghost"
                            aria-label={t('tax.periods.reopenMonth', { month: month(period) })}
                            onPress={() => {
                              setError(null);
                              setReopening(period);
                            }}
                          >
                            <RotateCcw className={iconClass.sm} aria-hidden="true" />
                            {t('tax.periods.reopen')}
                          </Button>
                          <Button
                            variant="dangerGhost"
                            aria-label={t('tax.periods.lockMonth', { month: month(period) })}
                            onPress={() => {
                              setError(null);
                              setLocking(period);
                            }}
                          >
                            <Lock className={iconClass.sm} aria-hidden="true" />
                            {t('tax.periods.lock')}
                          </Button>
                        </>
                      )}
                      {period.status === 'locked' && (
                        <span className={tableClasses.sub}>{t('tax.periods.final')}</span>
                      )}
                    </span>
                  </td>
                )}
              </tr>
            );
          })}
          {periods.isPending && (
            <tr className={tableClasses.empty}>
              <td colSpan={manage ? 5 : 4}>{t('loading')}</td>
            </tr>
          )}
        </tbody>
      </table>
      {periods.isError && <Alert>{t('tax.periods.loadFailed')}</Alert>}
      {list.length > RECENT_MONTHS && (
        <div className={styles.more}>
          <Button variant="ghost" onPress={() => setShowAll(!showAll)}>
            {showAll
              ? t('tax.periods.showRecent')
              : t('tax.periods.showAll', { count: list.length })}
          </Button>
        </div>
      )}
      <Note className={settingsClasses.tableNote}>{t('tax.periods.note')}</Note>
      {reopening && <ReopenDialog period={reopening} onClose={() => setReopening(null)} />}
      {locking && <LockDialog period={locking} onClose={() => setLocking(null)} />}
    </Card>
  );
}

/** Reopening a closed month needs a reason, kept in the audit log. */
function ReopenDialog({ period, onClose }: { period: PeriodItem; onClose: () => void }) {
  const { t, i18n } = useTranslation('setup');
  const { t: md } = useTranslation('masterdata');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [short, setShort] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const month = monthName(period.periodStart, i18n.language);
  const reopen = useSave(
    (api, body: { reason: string; rowVersion: number }, key) =>
      api.post(`/api/v1/periods/${period.id}/reopen`, body, { idempotencyKey: key }),
    {
      invalidate: [MD_KEYS.periods],
      onSuccess: () => {
        toast(t('tax.periods.reopenedToast', { month }));
        onClose();
      },
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (reason.trim().length < 3) return setShort(true);
    reopen.mutate({ reason: reason.trim(), rowVersion: period.rowVersion }, { onError: setError });
  };
  return (
    <Dialog isOpen onClose={onClose} title={t('tax.periods.reopenTitle', { month })}>
      <form className={settingsClasses.ucard} onSubmit={submit} noValidate>
        <Note>{t('tax.periods.reopenNote')}</Note>
        <TextField
          label={md('deactivate.reason')}
          value={reason}
          onChange={(value) => {
            setReason(value);
            setShort(false);
          }}
          error={short ? md('deactivate.reasonTooShort') : undefined}
          placeholder={md('deactivate.reasonHint')}
          multiline
          autoFocus
          maxLength={500}
        />
        <SaveProblem
          error={error}
          onReload={() => {
            void queryClient.invalidateQueries({ queryKey: MD_KEYS.periods });
            onClose();
          }}
        />
        <DialogFooter>
          <Button onPress={onClose}>{md('actions.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            busy={reopen.isPending}
            isDisabled={reopen.isPending || reason.trim().length < 3}
          >
            <RotateCcw className={iconClass.sm} aria-hidden="true" />
            {t('tax.periods.reopen')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Locking is permanent (decision 0016): a clear warning first. */
function LockDialog({ period, onClose }: { period: PeriodItem; onClose: () => void }) {
  const { t, i18n } = useTranslation('setup');
  const { t: md } = useTranslation('masterdata');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const month = monthName(period.periodStart, i18n.language);
  const lock = useSave(
    (api, body: { rowVersion: number }, key) =>
      api.post(`/api/v1/periods/${period.id}/lock`, body, { idempotencyKey: key }),
    {
      invalidate: [MD_KEYS.periods],
      onSuccess: () => {
        toast(t('tax.periods.lockedToast', { month }));
        onClose();
      },
    },
  );
  return (
    <Dialog isOpen onClose={onClose} title={t('tax.periods.lockTitle', { month })}>
      <div className={settingsClasses.ucard}>
        <Alert tone="warn" icon={<ShieldAlert aria-hidden="true" />}>
          {t('tax.periods.lockWarning', { month })}
        </Alert>
        <Note>{t('tax.periods.lockCorrections')}</Note>
        <SaveProblem
          error={error}
          onReload={() => {
            void queryClient.invalidateQueries({ queryKey: MD_KEYS.periods });
            onClose();
          }}
        />
        <DialogFooter>
          <Button onPress={onClose}>{md('actions.cancel')}</Button>
          <Button
            variant="danger"
            busy={lock.isPending}
            isDisabled={lock.isPending}
            onPress={() => {
              setError(null);
              lock.mutate({ rowVersion: period.rowVersion }, { onError: setError });
            }}
          >
            <Lock className={iconClass.sm} aria-hidden="true" />
            {t('tax.periods.lockConfirm')}
          </Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}
