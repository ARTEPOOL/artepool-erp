/**
 * Shift history (decision 0058): every shift with its over/short; a cashier sees their own, the
 * owner and the accountant see all, accept a closed shift's difference (it posts to Cash
 * over/short 6910) and see the cash alerts (drop due, repeated differences).
 */
import { useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ShiftListItem, ShiftReport } from '@artepool/shared/contracts';
import { useSave } from '../../../api/hooks';
import { formatDateTime } from '../../../lib/format';
import {
  Alert,
  Button,
  Card,
  Chip,
  Dialog,
  DialogFooter,
  Note,
  PageHeader,
  Segmented,
  tableClasses,
  TextField,
} from '../../../ui';
import { useCan, useDisplayName, useErrorText } from '../../auth/context';
import { money } from '../../masterdata/format';
import {
  POS_INVALIDATE,
  POS_PATHS,
  useCashAlerts,
  usePosState,
  useShiftReport,
  useShifts,
} from '../api';
import { CountFields, useCountForm } from './CountFields';
import { ShiftReportView } from './ShiftReportView';
import styles from '../pos.module.css';

type Filter = 'all' | 'pending' | 'open';

export function ShiftsPage() {
  const { t } = useTranslation('pos');
  const can = useCan();
  const nameOf = useDisplayName();
  const errorText = useErrorText();
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<ShiftListItem | null>(null);
  const [closing, setClosing] = useState<ShiftListItem | null>(null);
  const shifts = useShifts({
    ...(filter === 'pending' ? { pendingAcceptance: true } : {}),
    ...(filter === 'open' ? { status: 'open' as const } : {}),
  });
  const report = useShiftReport(selected);
  const alerts = useCashAlerts(can('shifts.view_all'));

  return (
    <>
      <PageHeader title={t('shifts.title')} subtitle={t('shifts.subtitle')} />
      {(alerts.data ?? []).map((a) => (
        <Alert key={a.id} tone="warn" icon={<AlertTriangle aria-hidden="true" />}>
          {t(`shifts.alert.${a.alertType}`, a.params)}
        </Alert>
      ))}
      <Card padding="table">
        <div className={styles.tableTools}>
          <Segmented<Filter>
            label={t('shifts.filter')}
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('shifts.all') },
              { value: 'pending', label: t('shifts.pending') },
              { value: 'open', label: t('shifts.open') },
            ]}
          />
        </div>
        <table className={tableClasses.table}>
          <thead>
            <tr>
              <th>{t('shifts.number')}</th>
              <th>{t('shifts.cashier')}</th>
              <th>{t('shifts.opened')}</th>
              <th className={tableClasses.num}>{t('shifts.expected')}</th>
              <th className={tableClasses.num}>{t('shifts.counted')}</th>
              <th className={tableClasses.num}>{t('shifts.variance')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(shifts.data?.shifts ?? []).map((s) => {
              const variance = s.varianceFils === null ? null : BigInt(s.varianceFils);
              return (
                <tr key={s.id} onClick={() => setSelected(s.id)} className={styles.clickRow}>
                  <td>
                    <bdi>{s.shiftNumber}</bdi>
                  </td>
                  <td>{nameOf(s.cashierName)}</td>
                  <td>
                    <bdi>{formatDateTime(s.openedAt)}</bdi>
                  </td>
                  <td className={tableClasses.num}>
                    <bdi>
                      {s.expectedCashFils === null ? '—' : money(BigInt(s.expectedCashFils))}
                    </bdi>
                  </td>
                  <td className={tableClasses.num}>
                    <bdi>{s.countedCashFils === null ? '—' : money(BigInt(s.countedCashFils))}</bdi>
                  </td>
                  <td className={tableClasses.num}>
                    {variance === null ? (
                      <Chip tone="info">{t('shifts.statusOpen')}</Chip>
                    ) : (
                      <bdi className={variance !== 0n ? styles.varianceOff : undefined}>
                        {money(variance)}
                      </bdi>
                    )}
                  </td>
                  <td>
                    {s.forceCloseReason !== null && (
                      <Chip tone="warn">{t('shifts.forceClosed')}</Chip>
                    )}
                    {s.status === 'open' && s.deviceRevoked && (
                      <Chip tone="warn">{t('shifts.onRevokedPc')}</Chip>
                    )}
                    {s.status === 'open' && can('shifts.force_close') && (
                      <Button
                        onPress={() => {
                          setClosing(s);
                        }}
                      >
                        {t('shifts.forceClose')}
                      </Button>
                    )}
                    {s.accepted ? (
                      <Chip tone="ok" icon={<CheckCircle2 aria-hidden="true" />}>
                        {t('shifts.accepted')}
                      </Chip>
                    ) : variance !== null &&
                      variance !== 0n &&
                      can('cash.variance_accept') &&
                      s.cashierId ? (
                      <Button
                        onPress={() => {
                          setAccepting(s);
                        }}
                      >
                        {t('shifts.accept')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {shifts.data?.shifts.length === 0 && (
              <tr className={tableClasses.empty}>
                <td colSpan={7}>{t('shifts.none')}</td>
              </tr>
            )}
          </tbody>
        </table>
        {shifts.error && <Alert>{errorText(shifts.error)}</Alert>}
      </Card>
      {report.data && <ShiftReportView report={report.data} printable />}
      {accepting && <AcceptDialog shift={accepting} onClose={() => setAccepting(null)} />}
      {closing && (
        <ForceCloseDialog
          shift={closing}
          onClose={() => setClosing(null)}
          onClosed={(id) => {
            setClosing(null);
            setSelected(id);
          }}
        />
      )}
    </>
  );
}

function AcceptDialog(props: { shift: ShiftListItem; onClose: () => void }) {
  const { t } = useTranslation('pos');
  const nameOf = useDisplayName();
  const errorText = useErrorText();
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const accept = useSave(
    (api, body: { note: string }, key) =>
      api.post<ShiftReport>(POS_PATHS.accept(props.shift.id), body, { idempotencyKey: key }),
    { invalidate: POS_INVALIDATE, onSuccess: props.onClose },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (note.trim().length < 3) return setProblem(t('shifts.noteRequired'));
    accept.mutate({ note: note.trim() }, { onError: (e) => setProblem(errorText(e)) });
  };
  return (
    <Dialog isOpen onClose={props.onClose} title={t('shifts.acceptTitle')}>
      <form onSubmit={submit} noValidate className={styles.payForm}>
        <Note>
          {t('shifts.acceptHelp', {
            number: props.shift.shiftNumber,
            name: nameOf(props.shift.cashierName),
            amount: money(BigInt(props.shift.varianceFils ?? '0')),
          })}
        </Note>
        <TextField label={t('shifts.acceptNote')} value={note} onChange={setNote} autoFocus />
        {problem && <Alert>{problem}</Alert>}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('cancel')}</Button>
          <Button type="submit" variant="primary" busy={accept.isPending}>
            {t('shifts.accept')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * Decision 0069: a shift that can no longer be closed on its own PC (enrolled again, broken or
 * gone) is closed here by the owner or the accountant: why, and a count of the drawer's cash.
 * The over/short stays the shift's cashier's and is accepted as usual.
 */
function ForceCloseDialog(props: {
  shift: ShiftListItem;
  onClose: () => void;
  onClosed: (shiftId: string) => void;
}) {
  const { t } = useTranslation('pos');
  const nameOf = useDisplayName();
  const errorText = useErrorText();
  const state = usePosState();
  const form = useCountForm(state.data?.denominations ?? []);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const close = useSave(
    (api, body: { reason: string }, key) =>
      api.post<ShiftReport>(
        POS_PATHS.forceClose(props.shift.id),
        { ...form.body(), reason: body.reason },
        { idempotencyKey: key },
      ),
    { invalidate: POS_INVALIDATE, onSuccess: () => props.onClosed(props.shift.id) },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (reason.trim().length < 3) return setProblem(t('shifts.noteRequired'));
    if (form.invalid) return setProblem(t('closeShift.invalid'));
    close.mutate({ reason: reason.trim() }, { onError: (e) => setProblem(errorText(e)) });
  };
  return (
    <Dialog isOpen wide onClose={props.onClose} title={t('shifts.forceCloseTitle')}>
      <form onSubmit={submit} noValidate className={styles.payForm}>
        <Note>
          {t('shifts.forceCloseHelp', {
            number: props.shift.shiftNumber,
            name: nameOf(props.shift.cashierName),
            pc: props.shift.deviceCode ?? '—',
          })}
        </Note>
        <TextField
          label={t('shifts.forceCloseReason')}
          value={reason}
          onChange={setReason}
          autoFocus
        />
        <CountFields form={form} />
        {problem && <Alert>{problem}</Alert>}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('cancel')}</Button>
          <Button type="submit" variant="primary" busy={close.isPending}>
            {t('shifts.forceClose')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
